import Darwin
import SwiftUI
import UIKit
import WebKit

// Xcode 27.1's iPhone Duo.simdevicetype declares iPhone19,4. Do not infer
// eligibility from window shape, size class, hinge availability, or device name.
enum DuoDevice {
    static let eligible: Bool = {
        if #available(iOS 27.1, *) {
            #if targetEnvironment(simulator)
            return ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] == "iPhone19,4"
            #else
            var system = utsname()
            uname(&system)
            let model = withUnsafePointer(to: &system.machine) {
                $0.withMemoryRebound(to: CChar.self, capacity: 1) { String(cString: $0) }
            }
            return model == "iPhone19,4"
            #endif
        }
        return false
    }()
}

struct DuoContent: View {
    @ObservedObject var shell: Shell

    var body: some View {
        NavigationStack {
            ShellWebView(webView: shell.webView)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar(.hidden, for: .navigationBar)
                .toolbar {
                    ToolbarItemGroup(placement: .bottomBar) {
                        Button(action: shell.refresh) {
                            Label(tr("刷新页面", "Refresh page"), systemImage: "arrow.clockwise")
                        }
                        Spacer()
                        Button { shell.duoAction("chat") } label: {
                            Label(tr("对话", "Chat"), systemImage: shell.duoMode == "chat" ? "bubble.left.fill" : "bubble.left")
                        }.disabled(!shell.duoReady || shell.duoBlocked)
                        Button { shell.duoAction("terminal") } label: {
                            Label(tr("终端", "Terminal"), systemImage: "terminal")
                        }.disabled(!shell.duoReady || shell.duoBlocked)
                        Menu {
                            Button { shell.duoAction("settings") } label: { Label(tr("设置", "Settings"), systemImage: "gearshape") }
                            Button { shell.duoAction("transfer") } label: { Label(tr("文件传输", "File transfer"), systemImage: "folder") }
                            Button { shell.duoAction("more") } label: { Label(tr("更多操作", "More actions"), systemImage: "ellipsis") }
                        } label: { Label(tr("更多", "More"), systemImage: "ellipsis") }
                        .disabled(!shell.duoReady || shell.duoBlocked)
                        if shell.duoCanClose {
                            Button { shell.duoAction("close") } label: { Label(tr("关闭面板", "Close panel"), systemImage: "xmark") }
                        }
                    }
                }
        }
        .ignoresSafeArea(.keyboard)
    }
}

// Only instantiated on confirmed Duo. Layout and hinge updates are coalesced;
// no display link, layout polling, or observations are installed on other devices.
@available(iOS 27.1, *)
final class DuoWebView: WKWebView {
    var layoutChanged: (([String: Any]) -> Void)?
    private var scheduled = false
    private var lastLayout = ""
    private var hingeState = "unknown"
    private var keyboardFrame = CGRect.null
    private var keyboardObserver: NSObjectProtocol?

    override init(frame: CGRect, configuration: WKWebViewConfiguration) {
        super.init(frame: frame, configuration: configuration)
        addInteraction(UIHingeInteraction { [weak self] _, update in
            guard let self else { return }
            switch update.hinge?.status {
            case .some(.fullyOpen): self.hingeState = "fullyOpen"
            case .some(.partiallyOpen): self.hingeState = "partiallyOpen"
            case .some(.closed): self.hingeState = "closed"
            default: self.hingeState = "unknown"
            }
            self.scheduleLayout()
        })
        keyboardObserver = NotificationCenter.default.addObserver(forName: UIResponder.keyboardWillChangeFrameNotification, object: nil, queue: .main) { [weak self] note in
            self?.keyboardFrame = (note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect) ?? .null
            self?.scheduleLayout()
        }
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    deinit { if let keyboardObserver { NotificationCenter.default.removeObserver(keyboardObserver) } }

    override func layoutSubviews() {
        super.layoutSubviews()
        // Query here so UIKit's automatic observation tracks internal region changes,
        // even when neither the bounds nor the safe-area insets change.
        reportLayout()
    }
    override func safeAreaInsetsDidChange() { super.safeAreaInsetsDidChange(); scheduleLayout() }
    override func didMoveToWindow() { super.didMoveToWindow(); scheduleLayout() }

    func scheduleLayout(force: Bool = false) {
        if force { lastLayout = "" }
        guard !scheduled else { return }
        scheduled = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.scheduled = false
            self.setNeedsLayout()
        }
    }

    private func reportLayout() {
        guard window != nil, !bounds.isEmpty else { return }
        func rect(_ r: CGRect) -> [String: CGFloat] { ["x": r.minX, "y": r.minY, "width": r.width, "height": r.height] }
        let insets = safeAreaInsets
        var regions: [[String: Any]] = []
        for (kind, name) in [(UIView.ReservedRegion.Kind.occlusion, "occlusion"), (.division, "division")] {
            for region in reservedRegions(kind: kind) where region.isActive {
                let clipped = region.frame.intersection(bounds)
                if !clipped.isNull && !clipped.isEmpty {
                    regions.append(["id": String(describing: region.id), "kind": name, "frame": rect(clipped), "isActive": true])
                }
            }
        }
        let keyboard = convert(keyboardFrame, from: nil).intersection(bounds)
        let payload: [String: Any] = [
            "hingeState": hingeState,
            "bounds": rect(bounds),
            "safeInsets": ["top": insets.top, "right": insets.right, "bottom": insets.bottom, "left": insets.left],
            "sizeClasses": ["horizontal": traitCollection.horizontalSizeClass.rawValue, "vertical": traitCollection.verticalSizeClass.rawValue],
            "reservedRegions": regions,
            "keyboard": keyboard.isNull || keyboard.isEmpty ? NSNull() : rect(keyboard)
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]),
              let key = String(data: data, encoding: .utf8), key != lastLayout else { return }
        lastLayout = key
        DispatchQueue.main.async { [weak self] in
            guard let self, self.lastLayout == key else { return }
            self.layoutChanged?(payload)
        }
    }
}
