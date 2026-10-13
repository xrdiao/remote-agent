import Combine
import SwiftUI
import UIKit
import WebKit

struct ContentView: View {
    @StateObject private var shell = Shell()

    var body: some View {
        ShellWebView(webView: shell.webView)
            .ignoresSafeArea()
            .background(Color(uiColor: shell.background))
            .preferredColorScheme(shell.light ? .light : .dark)
            .onAppear(perform: shell.start)
            .onOpenURL(perform: shell.openPairLink)
            .sheet(isPresented: $shell.scanning, onDismiss: shell.finishScan) {
                QRScanner { shell.scanned = $0; shell.scanning = false }
            }
            .sheet(isPresented: $shell.listening) {
                VoiceSheet(lang: shell.voiceLang) { shell.voiceDone($0) }
            }
            .alert(shell.notice ?? "", isPresented: Binding(get: { shell.notice != nil }, set: { if !$0 { shell.notice = nil } })) {
                Button(tr("好", "OK"), role: .cancel) {}
            }
    }
}

func tr(_ zh: String, _ en: String) -> String {
    Locale.preferredLanguages.first?.hasPrefix("zh") == true ? zh : en
}

private struct ShellWebView: UIViewRepresentable {
    let webView: WKWebView

    func makeUIView(context: Context) -> WKWebView { webView }
    func updateUIView(_ view: WKWebView, context: Context) {}
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

final class Shell: NSObject, ObservableObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    @Published private(set) var light = UserDefaults.standard.bool(forKey: "light")
    @Published var scanning = false
    @Published var scanned: String?
    @Published var listening = false
    @Published private(set) var voiceLang = ""
    @Published var notice: String?

    private var started = false
    private let setupPage = Bundle.main.url(forResource: "setup", withExtension: "html")!
    private let scripts = WKUserContentController()

    private var appURL: String {
        UserDefaults.standard.string(forKey: "url") ?? (Bundle.main.object(forInfoDictionaryKey: "AgentRemoteAppURL") as? String ?? "")
    }

    var background: UIColor { light ? .white : UIColor(white: 30 / 255, alpha: 1) }

    lazy var webView: WKWebView = {
        let config = WKWebViewConfiguration()
        config.userContentController = scripts
        config.allowsInlineMediaPlayback = true
        config.applicationNameForUserAgent = "AgentRemoteApp-iOS/" + (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "")
        scripts.add(WeakHandler(self), name: "app")
        let view = WKWebView(frame: .zero, configuration: config)
        view.navigationDelegate = self
        view.uiDelegate = self
        view.allowsBackForwardNavigationGestures = true
        view.isInspectable = true
        return view
    }()

    func start() {
        guard !started else { return }
        load(appURL)
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

    func voiceDone(_ text: String) {
        listening = false
        webView.evaluateJavaScript("window.onVoice && onVoice(\(json(text)))")
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
    // History, background-connection, notification and update methods are left out on purpose: the web app
    // feature-detects them and falls back to its browser behavior.
    private func installBridge() {
        scripts.removeAllUserScripts()
        scripts.addUserScript(WKUserScript(source: bridge(), injectionTime: .atDocumentStart, forMainFrameOnly: true))
    }

    private func bridge() -> String {
        """
        (() => {
          let url = \(json(appURL)), light = \(json(light));
          const canVoice = \(json(voiceAvailable()));
          const post = (fn, ...args) => window.webkit.messageHandlers.app.postMessage({ fn, args });
          window.AgentRemoteApp = {
            getUrl: () => url,
            isLight: () => light,
            takeOpenWin: () => '',
            canVoice: () => canVoice,
            setUrl(u) {
              if (!u.startsWith('https://')) return;
              url = u.split('#')[0];
              post('setUrl', u);
            },
            retry: () => post('retry'),
            changeUrl: () => post('changeUrl'),
            setTheme(on) { light = !!on; post('setTheme', light); },
            scan: () => post('scan'),
            voice(lang) { if (!canVoice) return false; post('voice', lang || ''); return true; },
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
        case "setUrl": setUrl(text)
        case "retry": load(appURL)
        case "changeUrl": loadSetup("change=1")
        case "setTheme": setTheme(args.first as? Bool ?? false)
        case "scan": scanning = true
        case "voice":
            voiceLang = text
            listening = true
        default: break
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

    private func failed(_ error: Error) {
        let e = error as NSError
        if e.code == NSURLErrorCancelled || (e.domain == "WebKitErrorDomain" && e.code == 102) { return }
        loadSetup("offline=1")
    }
}
