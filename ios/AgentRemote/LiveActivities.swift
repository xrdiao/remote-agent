import ActivityKit
import Foundation
import UIKit

// Live Activity tokens: the app uploads its push-to-start token once (iOS 17.2+) and each
// activity's update token as activities appear. The relay then drives them through the push service.
enum LiveActivities {
    private static var started = false

    static func start() {
        guard #available(iOS 17.2, *), Push.shared.serviceURL != nil, !started else { return }
        started = true
        Task {
            for await tokenData in Activity<AgentActivityAttributes>.pushToStartTokenUpdates {
                let token = tokenData.map { String(format: "%02x", $0) }.joined()
                UserDefaults.standard.set(token, forKey: "liveStartToken")
                await upload(kind: "start", key: nil, token: token)
            }
        }
        Task {
            for await activity in Activity<AgentActivityAttributes>.activityUpdates {
                watch(activity)
            }
        }
        for activity in Activity<AgentActivityAttributes>.activities {
            watch(activity)
        }
    }

    private static func watch(_ activity: Activity<AgentActivityAttributes>) {
        Task {
            for await tokenData in activity.pushTokenUpdates {
                let token = tokenData.map { String(format: "%02x", $0) }.joined()
                await upload(kind: "update", key: activity.attributes.key, token: token)
            }
        }
    }

    // The start token arrives before pairing; once /v1/register saves pushId/secret, send it again.
    static func flush() {
        guard #available(iOS 17.2, *), let token = UserDefaults.standard.string(forKey: "liveStartToken") else { return }
        Task { await upload(kind: "start", key: nil, token: token) }
    }

    private static func upload(kind: String, key: String?, token: String) async {
        guard let base = Push.shared.serviceURL,
              let pushId = UserDefaults.standard.string(forKey: "pushId"),
              let secret = UserDefaults.standard.string(forKey: "pushSecret"),
              let url = URL(string: base + "/v1/live/token") else { return }
        var body: [String: String] = ["pushId": pushId, "secret": secret, "kind": kind, "token": token]
        if let key { body["key"] = key }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        // Push-to-start can launch the app briefly in the background; hold a task for the upload.
        let taskId = await MainActor.run { UIApplication.shared.beginBackgroundTask() }
        defer { Task { await MainActor.run { UIApplication.shared.endBackgroundTask(taskId) } } }
        _ = try? await URLSession.shared.data(for: request)
    }
}
