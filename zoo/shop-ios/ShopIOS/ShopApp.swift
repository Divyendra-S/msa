import SwiftUI
import UIKit
import UserNotifications

@main
struct ShopApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @State private var model: ShopModel

    init() {
        let model = ShopModel(api: ShopApi(baseURL: Self.apiUrl(), session: Session()), history: OrderHistory())
        _model = State(initialValue: model)
        AppDelegate.model = model
    }

    var body: some Scene {
        WindowGroup {
            ShopView(model: model)
                .onOpenURL { model.handle(url: $0) }
        }
    }

    /**
     * Where the shop's API is: the `-apiUrl` launch argument (`simctl launch … -apiUrl http://…`),
     * kept for later launches that don't pass it. Without one, this Mac's port 3000.
     */
    private static func apiUrl() -> URL {
        let defaults = UserDefaults.standard
        // Launch arguments are in UserDefaults' argument domain, which isn't saved.
        if let passed = defaults.volatileDomain(forName: UserDefaults.argumentDomain)["apiUrl"] as? String {
            defaults.set(passed, forKey: "savedApiUrl")
        }
        return URL(string: defaults.string(forKey: "savedApiUrl") ?? "http://127.0.0.1:3000")!
    }
}

/// Push notifications from the shop: one that arrives while the app is open, or a silent one (`content-available`).
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    static var model: ShopModel?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        application.registerForRemoteNotifications()
        return true
    }

    func application(_ application: UIApplication, didReceiveRemoteNotification userInfo: [AnyHashable: Any]) async -> UIBackgroundFetchResult {
        Self.model?.handlePush(userInfo)
        return .newData
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        Self.model?.handlePush(notification.request.content.userInfo)
        return [.banner]
    }
}
