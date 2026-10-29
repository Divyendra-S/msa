import Foundation
import Security

/// The Anthropic API key, kept in the login keychain (never in defaults or files).
/// It only reaches the bridge's environment, for headless Claude hunts.
nonisolated enum Keychain {
  private static let service = "dev.windtunnel.mac"
  private static let account = "anthropic-api-key"

  static func read() -> String? {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var item: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
    return String(data: data, encoding: .utf8)
  }

  @discardableResult
  static func save(_ key: String) -> Bool {
    delete()
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
      kSecValueData as String: Data(key.utf8),
      kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlocked,
    ]
    return SecItemAdd(query as CFDictionary, nil) == errSecSuccess
  }

  static func delete() {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
    SecItemDelete(query as CFDictionary)
  }
}
