import ActivityKit
import Foundation

nonisolated enum NotificationTarget {
    static let fields = ["computer", "win", "windowId", "threadId"]

    static func json(read: (String) -> String?) -> String? {
        let target = Dictionary(uniqueKeysWithValues: fields.map { ($0, read($0) ?? "") })
        guard let data = try? JSONSerialization.data(withJSONObject: target, options: [.sortedKeys]) else { return nil }
        return String(decoding: data, as: UTF8.self)
    }
}

// Shared between the app (uploads tokens, opens deep links) and the widget extension (renders the activity).
nonisolated struct AgentActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        var phase: String      // working | waiting | done | stopped
        var label: String
        var detail: String
        var done: Int
        var total: Int
        var startedAt: Double  // unix seconds (not Date: ActivityKit decodes Date as 2001-reference seconds)
    }
    var computer: String; var win: String; var windowId: String; var threadId: String
    var app: String; var project: String; var thread: String; var pc: String
    var key: String { "\(computer)|\(win)|\(windowId)|\(threadId)" }
    var target: [String: String] { ["computer": computer, "win": win, "windowId": windowId, "threadId": threadId] }
}
