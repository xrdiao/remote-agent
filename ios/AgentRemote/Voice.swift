import AVFoundation
import Combine
import Speech
import SwiftUI

func voiceAvailable() -> Bool {
    let status = SFSpeechRecognizer.authorizationStatus()
    return status != .denied && status != .restricted && (SFSpeechRecognizer()?.isAvailable ?? false)
}

struct VoiceSheet: View {
    let lang: String
    let onDone: (String) -> Void
    @StateObject private var dictation = Dictation()

    var body: some View {
        VStack(spacing: 24) {
            Text(dictation.text.isEmpty ? tr("请说话…", "Listening…") : dictation.text)
                .font(.title3)
                .frame(maxWidth: .infinity, minHeight: 80, alignment: .leading)
            HStack(spacing: 16) {
                Button(tr("取消", "Cancel"), role: .cancel) { dictation.cancel() }
                Button(tr("完成", "Done")) { dictation.stop() }
                    .buttonStyle(.borderedProminent)
            }
        }
        .padding(24)
        .presentationDetents([.medium])
        .onAppear { dictation.start(lang: lang, onDone: onDone) }
        .onDisappear { dictation.cancel() }
    }
}

final class Dictation: ObservableObject {
    @Published private(set) var text = ""
    private let audio = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var quiet: Timer?
    private var onDone: ((String) -> Void)?

    func start(lang: String, onDone: @escaping (String) -> Void) {
        guard self.onDone == nil else { return }
        self.onDone = onDone
        SFSpeechRecognizer.requestAuthorization { speech in
            DispatchQueue.main.async {
                guard speech == .authorized else { return self.finish("") }
                requestMicrophone { granted in
                    DispatchQueue.main.async {
                        if granted { self.begin(lang) } else { self.finish("") }
                    }
                }
            }
        }
    }

    // Finishes with the final transcript once the recognizer has processed the audio that was already captured.
    func stop() {
        quiet?.invalidate()
        if audio.isRunning {
            audio.stop()
            audio.inputNode.removeTap(onBus: 0)
        }
        request?.endAudio()
    }

    func cancel() {
        finish("")
    }

    private func begin(_ lang: String) {
        guard let recognizer = lang.isEmpty ? SFSpeechRecognizer() : SFSpeechRecognizer(locale: Locale(identifier: lang)), recognizer.isAvailable else {
            return finish("")
        }
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        self.request = request
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .measurement, options: .duckOthers)
            try session.setActive(true, options: .notifyOthersOnDeactivation)
            let input = audio.inputNode
            input.installTap(onBus: 0, bufferSize: 1024, format: input.outputFormat(forBus: 0)) { buffer, _ in
                request.append(buffer)
            }
            audio.prepare()
            try audio.start()
        } catch {
            return finish("")
        }
        task = recognizer.recognitionTask(with: request) { result, error in
            DispatchQueue.main.async { self.handle(result, error) }
        }
    }

    private func handle(_ result: SFSpeechRecognitionResult?, _ error: Error?) {
        if let result {
            text = result.bestTranscription.formattedString
            if result.isFinal { return finish(text) }
            quiet?.invalidate()
            if !text.isEmpty {
                quiet = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: false) { [weak self] _ in self?.stop() }
            }
        } else if error != nil {
            finish(text)
        }
    }

    private func finish(_ result: String) {
        guard let done = onDone else { return }
        onDone = nil
        stop()
        task?.cancel()
        task = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        done(result)
    }
}

private func requestMicrophone(_ completion: @escaping (Bool) -> Void) {
    if #available(iOS 17, *) {
        AVAudioApplication.requestRecordPermission(completionHandler: completion)
    } else {
        AVAudioSession.sharedInstance().requestRecordPermission(completion)
    }
}
