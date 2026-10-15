import Combine
import Foundation
import UIKit
import UserNotifications

struct PushError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

// APNs token and push-service credentials. The web app reaches register() through the bridge's pushRegister().
final class Push: NSObject, ObservableObject, UNUserNotificationCenterDelegate {
    static let shared = Push()

    @Published var openRequest: String?

    private let defaults = UserDefaults.standard
    private var pending: [(Result<[String: String], Error>) -> Void] = []

    // Empty, unexpanded ($(PUSH_URL)) or non-https values mean notifications are off.
    var serviceURL: String? {
        guard let raw = Bundle.main.object(forInfoDictionaryKey: "AgentRemotePushURL") as? String else { return nil }
        var url = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        while url.hasSuffix("/") { url.removeLast() }
        guard url.hasPrefix("https://"), !url.contains("$(") else { return nil }
        return url
    }

    func launch() {
        UNUserNotificationCenter.current().delegate = self
        guard serviceURL != nil else { return }
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            guard settings.authorizationStatus == .authorized else { return }
            DispatchQueue.main.async { UIApplication.shared.registerForRemoteNotifications() }
        }
    }

    func register(completion: @escaping (Result<[String: String], Error>) -> Void) {
        guard serviceURL != nil else {
            return completion(.failure(PushError(message: tr("没有配置通知服务", "The notification service is not configured"))))
        }
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
            DispatchQueue.main.async {
                guard granted else {
                    return completion(.failure(PushError(message: tr("没有通知权限，请在系统设置里允许 Remote Agent 发通知", "No notification permission; allow Remote Agent in Settings"))))
                }
                self.pending.append(completion)
                UIApplication.shared.registerForRemoteNotifications()
            }
        }
    }

    func didRegister(token data: Data) {
        let token = data.map { String(format: "%02x", $0) }.joined()
        let waiting = pending
        pending = []
        if waiting.isEmpty && token == defaults.string(forKey: "pushToken") { return }
        upload(token) { result in waiting.forEach { $0(result) } }
    }

    func didFail(_ error: Error) {
        let waiting = pending
        pending = []
        let failure = PushError(message: tr("注册推送失败：", "Push registration failed: ") + error.localizedDescription)
        waiting.forEach { $0(.failure(failure)) }
    }

    private func upload(_ token: String, completion: @escaping (Result<[String: String], Error>) -> Void) {
        guard let base = serviceURL, let endpoint = URL(string: base + "/v1/register") else {
            return completion(.failure(PushError(message: tr("没有配置通知服务", "The notification service is not configured"))))
        }
        #if DEBUG
        let env = "sandbox"
        #else
        let env = "production"
        #endif
        var body: [String: String] = ["token": token, "env": env]
        if let pushId = defaults.string(forKey: "pushId"), let secret = defaults.string(forKey: "pushSecret") {
            body["pushId"] = pushId
            body["secret"] = secret
        }
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        URLSession.shared.dataTask(with: request) { data, response, error in
            DispatchQueue.main.async {
                let unreachable = { (detail: String) in
                    PushError(message: tr("连接通知服务失败：", "Could not reach the notification service: ") + detail)
                }
                if let error { return completion(.failure(unreachable(error.localizedDescription))) }
                guard let status = (response as? HTTPURLResponse)?.statusCode, status == 200,
                      let data, let out = try? JSONSerialization.jsonObject(with: data) as? [String: String],
                      let pushId = out["pushId"], let secret = out["secret"] else {
                    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                    return completion(.failure(unreachable("HTTP \(status)")))
                }
                self.defaults.set(pushId, forKey: "pushId")
                self.defaults.set(secret, forKey: "pushSecret")
                self.defaults.set(token, forKey: "pushToken")
                completion(.success(["url": base, "pushId": pushId, "secret": secret]))
            }
        }.resume()
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        let info = response.notification.request.content.userInfo
        var target: [String: String] = [:]
        for key in ["win", "windowId", "threadId"] { target[key] = info[key] as? String ?? "" }
        let data = try? JSONSerialization.data(withJSONObject: target, options: [.sortedKeys])
        openRequest = data.map { String(decoding: $0, as: UTF8.self) }
        completionHandler()
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        Push.shared.launch()
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Push.shared.didRegister(token: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        Push.shared.didFail(error)
    }
}
