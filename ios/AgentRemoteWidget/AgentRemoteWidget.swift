import ActivityKit
import SwiftUI
import WidgetKit

private func phaseIcon(_ phase: String) -> (String, Color) {
    switch phase {
    case "waiting": return ("exclamationmark.circle.fill", .orange)
    case "done": return ("checkmark.circle.fill", .green)
    case "stopped": return ("stop.circle.fill", .red)
    default: return ("ellipsis.circle", .blue)
    }
}

private func progressText(_ state: AgentActivityAttributes.ContentState) -> String {
    state.total > 0 ? "\(state.done)/\(state.total)" : ""
}

@ViewBuilder
private func timerText(_ state: AgentActivityAttributes.ContentState) -> some View {
    Text(timerInterval: Date(timeIntervalSince1970: state.startedAt)...Date.distantFuture, countsDown: false)
        .monospacedDigit()
}

private struct LockScreenView: View {
    let context: ActivityViewContext<AgentActivityAttributes>

    var body: some View {
        let s = context.state
        let (icon, tint) = phaseIcon(s.phase)
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Image(systemName: icon).foregroundStyle(tint)
                Text("\(context.attributes.app) · \(context.attributes.project)")
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                Spacer()
                if s.phase == "working" { timerText(s).font(.caption).foregroundStyle(.secondary) }
            }
            if !context.attributes.thread.isEmpty {
                Text(context.attributes.thread).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            HStack(spacing: 6) {
                Text(s.label).font(.caption.weight(.medium))
                if s.total > 0 {
                    ProgressView(value: Double(s.done), total: Double(s.total)).tint(tint)
                    Text(progressText(s)).font(.caption2).foregroundStyle(.secondary)
                }
            }
            if !s.detail.isEmpty {
                Text(s.detail).font(.caption2).foregroundStyle(.secondary).lineLimit(2)
            }
        }
        .widgetURL(deepLink(context.attributes))
        .activityBackgroundTint(Color(white: 0.12))
    }
}

private func deepLink(_ a: AgentActivityAttributes) -> URL? {
    var c = URLComponents()
    c.scheme = "agentremote"
    c.host = "open"
    c.queryItems = [URLQueryItem(name: "win", value: a.win), URLQueryItem(name: "windowId", value: a.windowId), URLQueryItem(name: "threadId", value: a.threadId)]
    return c.url
}

struct AgentRemoteWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: AgentActivityAttributes.self) { context in
            LockScreenView(context: context)
        } dynamicIsland: { context in
            let s = context.state
            let (icon, tint) = phaseIcon(s.phase)
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    HStack(spacing: 4) {
                        Image(systemName: icon).foregroundStyle(tint)
                        Text(context.attributes.app).font(.caption.weight(.semibold)).lineLimit(1)
                    }
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Group {
                        if s.total > 0 { Text(progressText(s)) } else if s.phase == "working" { timerText(s) }
                    }
                    .font(.caption).foregroundStyle(.secondary)
                }
                DynamicIslandExpandedRegion(.center) {
                    Text([context.attributes.project, context.attributes.thread].filter { !$0.isEmpty }.joined(separator: " · "))
                        .font(.caption).lineLimit(1)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(s.label).font(.caption.weight(.medium))
                        if s.total > 0 {
                            ProgressView(value: Double(s.done), total: Double(s.total)).tint(tint)
                        }
                        if !s.detail.isEmpty {
                            Text(s.detail).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                        }
                    }
                }
            } compactLeading: {
                Image(systemName: icon).foregroundStyle(tint)
            } compactTrailing: {
                if s.total > 0 && (s.phase == "working" || s.phase == "waiting") {
                    Text(progressText(s)).font(.caption2)
                } else if s.phase == "working" {
                    timerText(s).font(.caption2).frame(maxWidth: 44)
                } else {
                    Text(s.label).font(.caption2).lineLimit(1).frame(maxWidth: 44)
                }
            } minimal: {
                Image(systemName: icon).foregroundStyle(tint)
            }
        }
    }
}

@main
struct AgentRemoteWidgetBundle: WidgetBundle {
    var body: some Widget {
        AgentRemoteWidget()
    }
}
