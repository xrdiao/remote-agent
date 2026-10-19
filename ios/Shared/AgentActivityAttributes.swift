import ActivityKit
import Foundation

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
    var win: String; var windowId: String; var threadId: String
    var app: String; var project: String; var thread: String; var pc: String
    var key: String { "\(win)|\(windowId)|\(threadId)" }
}
