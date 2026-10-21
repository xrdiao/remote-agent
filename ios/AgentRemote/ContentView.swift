import Combine
import SwiftUI
import UIKit
import WebKit

struct ContentView: View {
    @StateObject private var shell = Shell()

    var body: some View {
        Group {
            if DuoDevice.eligible {
                DuoContent(shell: shell)
            } else {
                legacyContent
            }
        }
        .background(Color(uiColor: shell.background))
        .preferredColorScheme(shell.light ? .light : .dark)
        .onAppear(perform: shell.start)
        .onOpenURL(perform: shell.openUrl)
        .sheet(isPresented: $shell.scanning, onDismiss: shell.finishScan) {
            QRScanner { shell.scanned = $0; shell.scanning = false }
        }
        .alert(shell.notice ?? "", isPresented: Binding(get: { shell.notice != nil }, set: { if !$0 { shell.notice = nil } })) {
            Button(tr("好", "OK"), role: .cancel) {}
        }
    }

    private var legacyContent: some View {
        ZStack {
            ShellWebView(webView: shell.webView)
                .ignoresSafeArea()
            GeometryReader { geo in
                RefreshBubble(size: geo.size, light: shell.light, refresh: shell.refresh)
            }
            .ignoresSafeArea(.keyboard)
        }
    }
}

func tr(_ zh: String, _ en: String) -> String {
    if let lang = UserDefaults.standard.string(forKey: "lang"), lang == "zh" || lang == "en" { return lang == "zh" ? zh : en }
    return Locale.preferredLanguages.first?.hasPrefix("zh") == true ? zh : en
}

struct ShellWebView: UIViewRepresentable {
    let webView: WKWebView

    func makeUIView(context: Context) -> Container { Container() }

    func updateUIView(_ container: Container, context: Context) {
        guard container.subviews.first !== webView else { return }
        container.subviews.forEach { $0.removeFromSuperview() }
        container.addSubview(webView)
        container.setNeedsLayout()
    }

    // Sizes the web view during layout, never to the zero size the container has right after creation:
    // a page laid out at zero width measures the composer's placeholder as a tall column on cold launch.
    final class Container: UIView {
        override func layoutSubviews() {
            super.layoutSubviews()
            if !bounds.isEmpty { subviews.first?.frame = bounds }
        }
    }
}

// The user content controller retains its handlers, so it gets a weak proxy instead of the shell itself.
private final class WeakHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?

    init(_ target: WKScriptMessageHandler) {
        self.target = target
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(controller, didReceive: message)
    }
}

private final class WeakReplyHandler: NSObject, WKScriptMessageHandlerWithReply {
    weak var target: WKScriptMessageHandlerWithReply?

    init(_ target: WKScriptMessageHandlerWithReply) {
        self.target = target
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        target?.userContentController(controller, didReceive: message, replyHandler: replyHandler)
    }
}

final class Shell: NSObject, ObservableObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, WKScriptMessageHandlerWithReply {
    @Published private(set) var light = UserDefaults.standard.bool(forKey: "light")
    @Published var scanning = false
    @Published var scanned: String?
    @Published var notice: String?

    @Published private(set) var webView: WKWebView!
    @Published private(set) var duoReady = false
    @Published private(set) var duoBlocked = true
    @Published private(set) var duoCanClose = false
    @Published private(set) var duoMode = "chat"
    private var duoDocument = ""
    private var duoRevision = 0
    private var navigationGeneration = 0
    private var started = false
    private var pendingOpen = ""
    private var cancellables = Set<AnyCancellable>()
    private var scripts = WKUserContentController()
    private let setupPage = Bundle.main.url(forResource: "setup", withExtension: "html")!

    private var appURL: String {
        UserDefaults.standard.string(forKey: "url") ?? (Bundle.main.object(forInfoDictionaryKey: "AgentRemoteAppURL") as? String ?? "")
    }

    var background: UIColor {
        light
            ? UIColor(red: 0xF6 / 255, green: 0xF6 / 255, blue: 0xF4 / 255, alpha: 1)
            : UIColor(red: 0x0F / 255, green: 0x10 / 255, blue: 0x12 / 255, alpha: 1)
    }

    override init() {
        super.init()
        webView = makeWebView()
        Push.shared.$openRequest
            .compactMap { $0 }
            .receive(on: DispatchQueue.main)
            .sink { [weak self] payload in self?.openFromNotification(payload) }
            .store(in: &cancellables)
    }

    private func makeWebView() -> WKWebView {
        scripts = WKUserContentController()
        let config = WKWebViewConfiguration()
        config.userContentController = scripts
        config.allowsInlineMediaPlayback = true
        config.applicationNameForUserAgent = "AgentRemoteApp-iOS/" + (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "")
        scripts.add(WeakHandler(self), name: "app")
        scripts.addScriptMessageHandler(WeakReplyHandler(self), contentWorld: .page, name: "appReply")
        // The legacy path keeps its original initial size; Duo is sized by its container before loading.
        let view: WKWebView
        if DuoDevice.eligible, #available(iOS 27.1, *) {
            let duo = DuoWebView(frame: .zero, configuration: config)
            duo.layoutChanged = { [weak self, weak duo] layout in
                guard let self, let duo, duo === self.webView, !self.duoDocument.isEmpty else { return }
                self.duoRevision += 1
                var payload = layout
                payload["version"] = 1
                payload["duoEligible"] = true
                payload["documentGeneration"] = self.duoDocument
                payload["revision"] = self.duoRevision
                payload["nativeActions"] = self.duoReady ? ["chat", "terminal", "more", "settings", "transfer", "close"] : []
                duo.evaluateJavaScript("window.dispatchEvent(new CustomEvent('agentremote:duo-layout', {detail: \(self.json(payload))}));", completionHandler: nil)
            }
            view = duo
        } else {
            view = WKWebView(frame: UIScreen.main.bounds, configuration: config)
        }
        view.navigationDelegate = self
        view.uiDelegate = self
        // Without this the scroll view insets the safe areas, and WebKit then sizes 100dvh short of the
        // full-screen view, leaving a blank strip at the bottom (seen on iOS 26). The page pads itself via env().
        view.scrollView.contentInsetAdjustmentBehavior = .never
        view.allowsBackForwardNavigationGestures = true
        view.isInspectable = true
        return view
    }

    // Replaces the web view rather than reloading it: the current URL may carry a one-time #pair fragment,
    // and a hung or killed renderer can't be reloaded.
    func restart() {
        resetDuo()
        let old = webView!
        old.stopLoading()
        old.navigationDelegate = nil
        old.uiDelegate = nil
        scripts.removeScriptMessageHandler(forName: "app")
        scripts.removeScriptMessageHandler(forName: "appReply", contentWorld: .page)
        old.removeFromSuperview()
        webView = makeWebView()
        load(appURL)
    }

    // The bubble is the user's way to pick up a new web release: GitHub Pages serves max-age=600,
    // so drop the HTTP cache first. Storage, cookies and the service worker stay.
    func refresh() {
        WKWebsiteDataStore.default().removeData(ofTypes: [WKWebsiteDataTypeDiskCache, WKWebsiteDataTypeMemoryCache], modifiedSince: .distantPast) { [weak self] in
            self?.restart()
        }
    }

    func start() {
        guard !started else { return }
        load(appURL)
    }

    // agentremote://pair?app=…&d=… pairs; agentremote://open?win=…&windowId=…&threadId=… comes from a Live Activity tap.
    func openUrl(_ url: URL) {
        guard url.scheme == "agentremote", url.host == "open",
              let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems else {
            return openPairLink(url)
        }
        var target: [String: String] = [:]
        for key in ["win", "windowId", "threadId"] { target[key] = items.first { $0.name == key }?.value ?? "" }
        guard let data = try? JSONSerialization.data(withJSONObject: target, options: [.sortedKeys]) else { return }
        openFromNotification(String(decoding: data, as: UTF8.self))
    }

    // agentremote://pair?app=<https app address>&d=<url key>.<one-time code>, from the web app in a browser or a QR code.
    func openPairLink(_ url: URL) {
        guard url.scheme == "agentremote", let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems else { return }
        let app = items.first { $0.name == "app" }?.value
        let d = items.first { $0.name == "d" }?.value
        guard let app, let d, app.hasPrefix("https://"), d.range(of: #"^[\w-]+\.[\w-]+$"#, options: .regularExpression) != nil else { return }
        UserDefaults.standard.set(app, forKey: "url")
        load(app + "#pair=" + d)
    }

    func finishScan() {
        guard let code = scanned else { return }
        scanned = nil
        if code.hasPrefix("agentremote://") {
            URL(string: code).map(openPairLink)
        } else if code.hasPrefix("https://") {
            setUrl(code)
        } else {
            notice = tr("这不是 Remote Agent 的配对二维码", "Not a Remote Agent pairing QR code")
        }
    }

    private func setUrl(_ address: String) {
        guard address.hasPrefix("https://") else { return }
        UserDefaults.standard.set(address.components(separatedBy: "#")[0], forKey: "url")
        load(address)
    }

    private func setTheme(_ on: Bool) {
        light = on
        UserDefaults.standard.set(on, forKey: "light")
        applyTheme()
    }

    private func load(_ address: String) {
        prepare()
        guard !address.isEmpty, let url = URL(string: address) else { return loadSetup() }
        webView.load(URLRequest(url: url))
    }

    private func loadSetup(_ query: String? = nil) {
        prepare()
        var parts = URLComponents(url: setupPage, resolvingAgainstBaseURL: false)
        parts?.query = query
        webView.loadFileURL(parts?.url ?? setupPage, allowingReadAccessTo: setupPage.deletingLastPathComponent())
    }

    private func prepare() {
        started = true
        applyTheme()
        installBridge()
    }

    private func applyTheme() {
        webView.isOpaque = false
        webView.backgroundColor = background
        webView.scrollView.backgroundColor = background
    }

    // Android's bridge calls are synchronous; WKWebView is not, so the values the page reads are baked in here.
    // History, background-connection and update methods are left out on purpose: the web app
    // feature-detects them and falls back to its browser behavior. pushRegister exists only when a push service is set.
    private func installBridge() {
        scripts.removeAllUserScripts()
        scripts.addUserScript(WKUserScript(source: bridge(), injectionTime: .atDocumentStart, forMainFrameOnly: true))
    }

    private func bridge() -> String {
        let pushRegister = Push.shared.serviceURL == nil ? "" : """
            pushRegister: () => window.webkit.messageHandlers.appReply.postMessage({ fn: 'pushRegister' }).catch(e => { throw new Error(String(e && e.message || e)); }),
            """
        return """
        (() => {
          let url = \(json(appURL)), light = \(json(light)), openWin = \(json(pendingOpen));
          let lang = \(json(UserDefaults.standard.string(forKey: "lang") ?? ""));
          const pendingLang = \(json(UserDefaults.standard.string(forKey: "pendingLang") ?? ""));
          const appHost = \(json(URL(string: appURL)?.host ?? ""));
          const post = (fn, ...args) => window.webkit.messageHandlers.app.postMessage({ fn, args });
          if (pendingLang && location.protocol === 'https:' && location.host === appHost) {
            try { localStorage.setItem('cr-lang', pendingLang); post('tookLang'); } catch (e) {}
          }
          if (\(json(DuoDevice.eligible))) {
            window.AgentRemoteDuo = Object.freeze({
              version: 1, duoEligible: true, documentGeneration: crypto.randomUUID(),
              report: state => post('duoState', {...state, documentGeneration: window.AgentRemoteDuo.documentGeneration})
            });
          }
          window.AgentRemoteApp = {
            getUrl: () => url,
            getLang: () => lang,
            setLang(v) { if (v !== 'zh' && v !== 'en') return; lang = v; post('setLang', v); },
            isLight: () => light,
            takeOpenWin: () => { const v = openWin; openWin = ''; if (v) post('tookOpenWin'); return v; },
            _setOpenWin(v) { openWin = v; },
            setUrl(u) {
              if (!u.startsWith('https://')) return;
              url = u.split('#')[0];
              post('setUrl', u);
            },
            retry: () => post('retry'),
            changeUrl: () => post('changeUrl'),
            setTheme(on) { light = !!on; post('setTheme', light); },
            scan: () => post('scan'),
            \(pushRegister)
          };
        })();
        """
    }

    private func json(_ value: Any) -> String {
        let data = try! JSONSerialization.data(withJSONObject: [value])
        return String(decoding: data.dropFirst().dropLast(), as: UTF8.self)
    }

    private func sameOrigin(_ url: URL) -> Bool {
        guard !appURL.isEmpty, let base = URL(string: appURL) else { return false }
        return url.scheme == base.scheme && url.host == base.host
    }

    private func trusted(_ origin: WKSecurityOrigin) -> Bool {
        if origin.protocol == "file" { return true }
        guard !appURL.isEmpty, let base = URL(string: appURL) else { return false }
        return origin.protocol == base.scheme && origin.host == base.host
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, trusted(message.frameInfo.securityOrigin),
              let body = message.body as? [String: Any], let fn = body["fn"] as? String else { return }
        let args = body["args"] as? [Any] ?? []
        let text = args.first as? String ?? ""
        switch fn {
        case "duoState":
            guard DuoDevice.eligible, message.webView === webView,
                  let state = args.first as? [String: Any], let document = state["documentGeneration"] as? String else { return }
            let generation = navigationGeneration
            let view = webView!
            view.evaluateJavaScript("window.AgentRemoteDuo?.documentGeneration === \(json(document))") { [weak self, weak view] result, _ in
                guard let self, let view, view === self.webView, generation == self.navigationGeneration, result as? Bool == true else { return }
                self.duoDocument = document
                self.duoReady = state["ready"] as? Bool == true
                self.duoBlocked = state["blocked"] as? Bool != false
                self.duoCanClose = state["canClose"] as? Bool == true
                self.duoMode = state["mode"] as? String ?? "chat"
                if #available(iOS 27.1, *) { (view as? DuoWebView)?.scheduleLayout(force: true) }
            }
        case "setUrl": setUrl(text)
        case "retry": load(appURL)
        case "changeUrl": loadSetup("change=1")
        case "setTheme": setTheme(args.first as? Bool ?? false)
        case "scan": scanning = true
        case "tookOpenWin": pendingOpen = ""
        case "setLang":
            if text == "zh" || text == "en" {
                UserDefaults.standard.set(text, forKey: "lang")
                UserDefaults.standard.set(text, forKey: "pendingLang")
            }
        case "tookLang": UserDefaults.standard.removeObject(forKey: "pendingLang")
        default: break
        }
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        let unsupported = tr("不支持的操作", "Unsupported action")
        guard message.frameInfo.isMainFrame, trusted(message.frameInfo.securityOrigin),
              let body = message.body as? [String: Any], let fn = body["fn"] as? String else { return replyHandler(nil, unsupported) }
        switch fn {
        case "pushRegister":
            Push.shared.register { result in
                switch result {
                case .success(let registration): replyHandler(registration, nil)
                case .failure(let error): replyHandler(nil, error.localizedDescription)
                }
            }
        default: replyHandler(nil, unsupported)
        }
    }

    private func resetDuo() {
        guard DuoDevice.eligible else { return }
        navigationGeneration += 1
        duoReady = false
        duoBlocked = true
        duoCanClose = false
        duoDocument = ""
    }

    func duoAction(_ action: String) {
        guard DuoDevice.eligible, duoReady, ["chat", "terminal", "more", "settings", "transfer", "close"].contains(action),
              action == "close" ? duoCanClose : !duoBlocked else { return }
        let detail = json(["action": action, "documentGeneration": duoDocument])
        webView.evaluateJavaScript("window.dispatchEvent(new CustomEvent('agentremote:duo-action', {detail: \(detail)}));", completionHandler: nil)
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        if webView === self.webView { resetDuo() }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard webView === self.webView, !pendingOpen.isEmpty else { return }
        openFromNotification(pendingOpen)
    }

    private func openFromNotification(_ payload: String) {
        pendingOpen = payload
        let script = "(() => { if (window.openWin) { openWin(\(json(payload))); return true; } window.AgentRemoteApp?._setOpenWin?.(\(json(payload))); return false; })()"
        webView.evaluateJavaScript(script) { [weak self] result, _ in
            if result as? Bool == true { self?.pendingOpen = "" }
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url, action.targetFrame?.isMainFrame ?? true else { return decisionHandler(.allow) }
        if url.isFileURL || url.scheme == "about" || sameOrigin(url) { return decisionHandler(.allow) }
        UIApplication.shared.open(url)
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url {
            if sameOrigin(url) { webView.load(action.request) } else { UIApplication.shared.open(url) }
        }
        return nil
    }

    // Without this WebKit asks per origin and forgets once the app is killed; the OS microphone permission still gates access.
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(type == .microphone && frame.isMainFrame && trusted(origin) ? .grant : .prompt)
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        dialog(webView, message) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        dialog(webView, message, cancelable: true, completionHandler)
    }

    private func dialog(_ view: WKWebView, _ message: String, cancelable: Bool = false, _ done: @escaping (Bool) -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: tr("好", "OK"), style: .default) { _ in done(true) })
        if cancelable { alert.addAction(UIAlertAction(title: tr("取消", "Cancel"), style: .cancel) { _ in done(false) }) }
        guard var top = view.window?.rootViewController else { return done(false) }
        while let presented = top.presentedViewController { top = presented }
        top.present(alert, animated: true)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        failed(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        failed(error)
    }

    func webViewWebContentProcessDidTerminate(_ view: WKWebView) {
        guard view === webView else { return }
        restart()
    }

    private func failed(_ error: Error) {
        let e = error as NSError
        if e.code == NSURLErrorCancelled || (e.domain == "WebKitErrorDomain" && e.code == 102) { return }
        loadSetup("offline=1")
    }
}
