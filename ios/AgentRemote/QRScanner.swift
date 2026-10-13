import AVFoundation
import SwiftUI
import UIKit

struct QRScanner: View {
    let onFinish: (String?) -> Void
    @State private var problem: Problem?

    var body: some View {
        ZStack {
            CodeCamera(onCode: onFinish, onProblem: { problem = $0 })
                .ignoresSafeArea()
            VStack {
                HStack {
                    Spacer()
                    Button(tr("取消", "Cancel")) { onFinish(nil) }
                        .buttonStyle(.borderedProminent)
                }
                Spacer()
                Text(tr("扫描电脑上 npm run pair 显示的二维码", "Scan the QR code shown by npm run pair"))
                    .padding()
                    .background(.black.opacity(0.6), in: RoundedRectangle(cornerRadius: 12))
            }
            .padding()
            .foregroundStyle(.white)
        }
        .alert(problem?.title ?? "", isPresented: Binding(get: { problem != nil }, set: { if !$0 { problem = nil } })) {
            if problem == .denied {
                Button(tr("打开设置", "Open Settings")) { UIApplication.shared.open(URL(string: UIApplication.openSettingsURLString)!) }
            }
            Button(tr("好", "OK"), role: .cancel) { onFinish(nil) }
        } message: {
            Text(problem?.message ?? "")
        }
    }
}

private enum Problem: Equatable {
    case denied, noCamera

    var title: String { tr("无法扫码", "Cannot scan") }

    var message: String {
        switch self {
        case .denied: tr("请到设置里允许 Remote Agent 使用相机", "Allow Remote Agent to use the camera in Settings.")
        case .noCamera: tr("这台设备没有可用的相机", "This device has no camera available.")
        }
    }
}

private struct CodeCamera: UIViewControllerRepresentable {
    let onCode: (String) -> Void
    let onProblem: (Problem) -> Void

    func makeUIViewController(context: Context) -> CodeCameraController {
        let controller = CodeCameraController()
        controller.onCode = onCode
        controller.onProblem = onProblem
        return controller
    }

    func updateUIViewController(_ controller: CodeCameraController, context: Context) {}
}

private final class CodeCameraController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var onCode: (String) -> Void = { _ in }
    var onProblem: (Problem) -> Void = { _ in }
    private let session = AVCaptureSession()
    private var preview: AVCaptureVideoPreviewLayer?
    private var found = false

    override func viewDidLoad() {
        super.viewDidLoad()
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            setUp()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { granted in
                DispatchQueue.main.async {
                    if granted { self.setUp() } else { self.report(.denied) }
                }
            }
        default:
            report(.denied)
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        preview?.frame = view.bounds
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        let session = session
        Task.detached { session.stopRunning() }
    }

    private func setUp() {
        guard let device = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device),
              session.canAddInput(input) else { return report(.noCamera) }
        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else { return report(.noCamera) }
        session.addInput(input)
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]

        let layer = AVCaptureVideoPreviewLayer(session: session)
        layer.videoGravity = .resizeAspectFill
        view.layer.addSublayer(layer)
        preview = layer

        let session = session
        Task.detached { session.startRunning() }
    }

    private func report(_ problem: Problem) {
        DispatchQueue.main.async { self.onProblem(problem) }
    }

    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput objects: [AVMetadataObject], from connection: AVCaptureConnection) {
        guard !found, let code = objects.first as? AVMetadataMachineReadableCodeObject, let text = code.stringValue else { return }
        found = true
        onCode(text)
    }
}
