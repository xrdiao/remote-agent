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

@ViewBuilder
private func logo(for app: String, _ size: CGFloat) -> some View {
    switch app.lowercased() {
    case "cursor", "devin", "codex":
        Image("logo-\(app.lowercased())")
            .resizable().scaledToFit()
            .frame(width: size, height: size)
    default:
        Image(systemName: "sparkles")
            .resizable().scaledToFit()
            .frame(width: size, height: size)
    }
}

private func progressText(_ state: AgentActivityAttributes.ContentState) -> String {
    state.total > 0 ? "\(state.done)/\(state.total)" : ""
}

// timerInterval reserves room for the longest possible duration string; give it a fixed frame or it pushes everything else out.
@ViewBuilder
private func timerText(_ state: AgentActivityAttributes.ContentState, width: CGFloat) -> some View {
    Text(timerInterval: Date(timeIntervalSince1970: state.startedAt)...Date.distantFuture, countsDown: false)
        .monospacedDigit()
        .frame(width: width, alignment: .trailing)
        .multilineTextAlignment(.trailing)
}

@ViewBuilder
private func phaseBadge(_ state: AgentActivityAttributes.ContentState) -> some View {
    let (icon, tint) = phaseIcon(state.phase)
    HStack(spacing: 4) {
        Image(systemName: icon)
        Text(state.label)
    }
    .font(.caption.weight(.medium))
    .foregroundStyle(tint)
}

private struct LockScreenView: View {
    let context: ActivityViewContext<AgentActivityAttributes>

    var body: some View {
        let s = context.state
        let (_, tint) = phaseIcon(s.phase)
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                logo(for: context.attributes.app, 20)
                Text("\(context.attributes.app) · \(context.attributes.project)")
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                    .layoutPriority(1)
                Spacer(minLength: 8)
                if s.phase == "working" {
                    timerText(s, width: 64).font(.caption).foregroundStyle(.secondary)
                }
            }
            if !context.attributes.thread.isEmpty {
                Text(context.attributes.thread)
                    .font(.footnote).foregroundStyle(.secondary).lineLimit(2)
            }
            HStack(spacing: 6) {
                phaseBadge(s)
                if s.total > 0 {
                    ProgressView(value: Double(s.done), total: Double(s.total)).tint(tint)
                    Text(progressText(s)).font(.caption2).foregroundStyle(.secondary)
                }
            }
            if !s.detail.isEmpty {
                Text(s.detail).font(.caption).foregroundStyle(.secondary).lineLimit(2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
        .widgetURL(deepLink(context.attributes))
        .activityBackgroundTint(Color(white: 0.12))
    }
}

private func deepLink(_ a: AgentActivityAttributes) -> URL? {
    var c = URLComponents()
    c.scheme = "agentremote"
    c.host = "open"
    c.queryItems = [URLQueryItem(name: "computer", value: a.computer), URLQueryItem(name: "win", value: a.win), URLQueryItem(name: "windowId", value: a.windowId), URLQueryItem(name: "threadId", value: a.threadId)]
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
                // Top row: who (logo, app, project) on the left, state and time on the right; everything else
                // left-aligned underneath. No center region: it sits under the camera and breaks the alignment.
                DynamicIslandExpandedRegion(.leading) {
                    HStack(spacing: 8) {
                        logo(for: context.attributes.app, 24)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(context.attributes.app).font(.caption2).foregroundStyle(.secondary)
                            Text(context.attributes.project).font(.subheadline.weight(.semibold)).lineLimit(1)
                        }
                    }
                    .padding(.leading, 4)
                    .dynamicIsland(verticalPlacement: .belowIfTooWide)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    VStack(alignment: .trailing, spacing: 1) {
                        phaseBadge(s).font(.caption2)
                        if s.phase == "working" {
                            timerText(s, width: 80).font(.title3.weight(.semibold))
                        } else if s.total > 0 {
                            Text(progressText(s)).font(.title3.weight(.semibold)).monospacedDigit()
                        }
                    }
                    .padding(.trailing, 4)
                    .dynamicIsland(verticalPlacement: .belowIfTooWide)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 6) {
                        if !context.attributes.thread.isEmpty {
                            Text(context.attributes.thread).font(.subheadline).lineLimit(2)
                        }
                        if s.total > 0 {
                            HStack(spacing: 8) {
                                ProgressView(value: Double(s.done), total: Double(s.total)).tint(tint)
                                Text(progressText(s)).font(.caption).monospacedDigit().foregroundStyle(.secondary)
                            }
                        }
                        if !s.detail.isEmpty {
                            Text(s.detail).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 4)
                    .padding(.top, 4)
                }
            } compactLeading: {
                logo(for: context.attributes.app, 18)
            } compactTrailing: {
                if s.total > 0 && (s.phase == "working" || s.phase == "waiting") {
                    Text(progressText(s)).font(.caption2).monospacedDigit().foregroundStyle(tint)
                } else if s.phase == "working" {
                    timerText(s, width: 42).font(.caption2).foregroundStyle(.blue)
                } else {
                    Image(systemName: icon).foregroundStyle(tint)
                }
            } minimal: {
                logo(for: context.attributes.app, 16)
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
