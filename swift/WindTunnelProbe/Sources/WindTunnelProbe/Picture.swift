import SwiftUI
#if DEBUG && os(macOS)
import AppKit
import AVFoundation
#endif

extension Probe {
    /// A step of a test scenario that shows what the user would see at its end: `view`, drawn once
    /// the step's code has run (or failed). Replay shows it as the step's screenshot, with the probe
    /// points under it.
    ///
    /// The view is drawn in a window that is never put on screen, at twice `size` in pixels. What
    /// the GPU draws straight to the screen (Metal) may come out blank. Outside a run, and in
    /// release builds, `view` is never called.
    public static func step<T, V: View>(
        _ name: String,
        showing view: @MainActor () async -> V,
        size: CGSize = CGSize(width: 1280, height: 800),
        isolation: isolated (any Actor)? = #isolation,
        _ body: () async throws -> T
    ) async rethrows -> T {
        #if DEBUG
        guard let harness = Harness.shared else { return try await body() }
        await harness.step(name, phase: "start", error: nil)
        do {
            let value = try await body()
            await harness.step(name, phase: "end", error: nil, picture: await picture(of: view, size: size))
            return value
        } catch {
            await harness.step(name, phase: "end", error: error, picture: await picture(of: view, size: size))
            throw error
        }
        #else
        return try await body()
        #endif
    }
}

#if DEBUG
/// `view` as a JPEG, drawn in a window that is never ordered in: nothing shows on screen.
@MainActor
private func picture<V: View>(of view: @MainActor () async -> V, size: CGSize) async -> Data? {
    #if os(macOS)
    // No Dock icon or menu bar, whatever process this is (an app hosting the scenario, or xctest).
    NSApplication.shared.setActivationPolicy(.prohibited)
    let hosting = NSHostingView(rootView: await view())
    hosting.wantsLayer = true
    let window = PictureWindow(
        contentRect: CGRect(origin: .zero, size: size),
        styleMask: [.titled, .fullSizeContentView, .resizable],
        backing: .buffered,
        defer: false
    )
    window.titlebarAppearsTransparent = true
    window.titleVisibility = .hidden
    window.isReleasedWhenClosed = false
    window.contentView = hosting
    // Kept until the scenario ends, as a window the user leaves open: a view that acts as it goes
    // away (an export page that cancels its export on disappear) would act on the scenario's code.
    pictureWindows.append(window)
    // A moment to lay out, and for what the view loads as it appears. Kept short: the step's
    // scenario waits for it, while the app's own work goes on.
    for _ in 0..<3 {
        hosting.layoutSubtreeIfNeeded()
        try? await Task.sleep(for: .milliseconds(80))
    }
    let bounds = hosting.bounds
    // The window's layers, title bar and toolbar included, over the window's ground, at twice the
    // size: sharp text when Replay shows the picture large on a Retina screen.
    let scale: CGFloat = 2
    let width = Int(bounds.width * scale), height = Int(bounds.height * scale)
    guard let layer = hosting.superview?.layer ?? hosting.layer,
          let context = CGContext(
            data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
          )
    else {
        return nil
    }
    var ground = NSColor.windowBackgroundColor.cgColor
    hosting.effectiveAppearance.performAsCurrentDrawingAppearance { ground = NSColor.windowBackgroundColor.cgColor }
    context.setFillColor(ground)
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    context.scaleBy(x: scale, y: scale)
    hideGlass(in: layer)
    await showPlayers(in: layer)
    layer.render(in: context)
    guard let image = context.makeImage() else { return nil }
    // Encoded off the main actor, which the app's own work needs meanwhile.
    return await Task.detached(priority: .userInitiated) {
        NSBitmapImageRep(cgImage: image).representation(using: .jpeg, properties: [.compressionFactor: 0.85])
    }.value
    #else
    return nil
    #endif
}

#if os(macOS)
/// Every picture's window, kept open (off screen) while the scenario runs.
@MainActor private var pictureWindows: [NSWindow] = []

/// Puts each video player's current frame where its video shows: a player layer sends its picture
/// straight to the screen, so drawn here it would be black. The frame comes through the item's video
/// composition, as the player shows it.
@MainActor
private func showPlayers(in layer: CALayer) async {
    if let playerLayer = layer as? AVPlayerLayer {
        guard let item = playerLayer.player?.currentItem else { return }
        let generator = AVAssetImageGenerator(asset: item.asset)
        generator.videoComposition = item.videoComposition
        generator.appliesPreferredTrackTransform = true
        generator.requestedTimeToleranceBefore = .zero
        generator.requestedTimeToleranceAfter = .zero
        guard let frame = try? await generator.image(at: item.currentTime()).image else { return }
        let picture = CALayer()
        picture.contents = frame
        picture.contentsGravity = .resizeAspect
        picture.frame = playerLayer.videoRect.isEmpty ? playerLayer.bounds : playerLayer.videoRect
        playerLayer.addSublayer(picture)
        return
    }
    for sublayer in layer.sublayers ?? [] {
        await showPlayers(in: sublayer)
    }
}

/// Hides Liquid Glass and blur-behind layers. They show what's behind them, which a window that
/// isn't on screen doesn't have: drawn here, a glass column comes out as its raw shape texture.
/// What they hold stays; the window's ground shows through instead.
@MainActor
private func hideGlass(in layer: CALayer) {
    let name = NSStringFromClass(type(of: layer))
    if name.contains("SDF") || name == "CABackdropLayer" {
        layer.isHidden = true
        return
    }
    for sublayer in layer.sublayers ?? [] {
        hideGlass(in: sublayer)
    }
}

/// Drawn as the active window, as the user sees the app they're using: controls aren't dimmed.
private final class PictureWindow: NSWindow {
    override var isKeyWindow: Bool { true }
    override var isMainWindow: Bool { true }
    override var canBecomeKey: Bool { true }
}
#endif
#endif
