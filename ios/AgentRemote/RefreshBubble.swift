import SwiftUI

// A native refresh button over the web view, so the app can be recovered when the page itself is frozen.
struct RefreshBubble: View {
    let size: CGSize
    let light: Bool
    let refresh: () -> Void

    @AppStorage("bubbleRight") private var right = true
    @AppStorage("bubbleY") private var fraction = 0.6
    @State private var center = CGPoint.zero
    @State private var origin = CGPoint.zero
    @State private var expanded = false
    @State private var dragging = false
    @State private var spin = 0.0
    @State private var idle: Task<Void, Never>?

    private let diameter: CGFloat = 44
    private let margin: CGFloat = 8

    private var half: CGFloat { diameter / 2 }

    private var drag: some Gesture {
        DragGesture(minimumDistance: 10, coordinateSpace: .global)
            .onChanged { value in
                if !dragging {
                    dragging = true
                    origin = center
                    spin = 0
                    idle?.cancel()
                }
                center = clamp(CGPoint(x: origin.x + value.translation.width, y: origin.y + value.translation.height))
            }
            .onEnded { value in
                snap(clamp(CGPoint(x: origin.x + value.translation.width, y: origin.y + value.translation.height)))
            }
    }

    var body: some View {
        ZStack(alignment: .topLeading) {
            Image(systemName: "arrow.clockwise")
                .resizable()
                .scaledToFit()
                .padding(10)
                .foregroundStyle(light ? Color(white: 0.2) : .white)
                .frame(width: diameter, height: diameter)
                .background(Circle().fill(light ? .white : Color(white: 60.0 / 255)).shadow(color: .black.opacity(0.25), radius: 4, y: 2))
                .rotationEffect(.degrees(spin))
                .opacity(expanded || dragging ? 0.9 : 0.2)
                .offset(x: center.x - half, y: center.y - half)
                .onTapGesture { expanded ? refreshNow() : expand() }
                .gesture(drag)
                .accessibilityLabel(tr("刷新页面", "Refresh page"))
                .accessibilityAddTraits(.isButton)
                .accessibilityAction { refreshNow() }
        }
        .frame(width: size.width, height: size.height, alignment: .topLeading)
        .onAppear(perform: place)
        .onChange(of: size) { _ in place() }
    }

    // Called on first layout and whenever the screen size changes: resting at the saved edge and height.
    private func place() {
        idle?.cancel()
        expanded = false
        dragging = false
        var still = Transaction()
        still.disablesAnimations = true
        withTransaction(still) {
            spin = 0
            center = CGPoint(x: edgeX(shown: false), y: clampY(CGFloat(fraction) * size.height))
        }
    }

    private func expand() {
        withAnimation(.easeInOut(duration: 0.18)) {
            expanded = true
            center.x = edgeX(shown: true)
        }
        startIdle()
    }

    private func tuck() {
        guard expanded else { return }
        withAnimation(.easeInOut(duration: 0.18)) {
            expanded = false
            center.x = edgeX(shown: false)
        }
    }

    private func refreshNow() {
        withAnimation(.easeInOut(duration: 0.36)) { spin += 360 }
        startIdle()
        refresh()
    }

    private func snap(_ at: CGPoint) {
        dragging = false
        right = at.x >= size.width / 2
        fraction = Double(at.y / size.height)
        expanded = true
        withAnimation(.easeInOut(duration: 0.18)) { center = CGPoint(x: edgeX(shown: true), y: at.y) }
        startIdle()
    }

    private func startIdle() {
        idle?.cancel()
        idle = Task {
            try? await Task.sleep(for: .seconds(2))
            if !Task.isCancelled { tuck() }
        }
    }

    private func edgeX(shown: Bool) -> CGFloat {
        if shown { return right ? size.width - margin - half : margin + half }
        return right ? size.width : 0
    }

    private func clamp(_ p: CGPoint) -> CGPoint {
        CGPoint(x: min(max(p.x, half), size.width - half), y: clampY(p.y))
    }

    private func clampY(_ y: CGFloat) -> CGFloat {
        min(max(y, margin + half), size.height - margin - half)
    }
}
