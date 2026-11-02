import Foundation

struct Product: Decodable, Identifiable {
    let id: Int
    let name: String
    let priceCents: Int
    let stock: Int
}

struct CartItem: Decodable {
    let productId: Int
    let name: String
    let quantity: Int
    let priceCents: Int
}

struct Cart: Decodable {
    let cartId: Int?
    let items: [CartItem]
    let totalCents: Int
}

/// An order as the shop lists it.
struct RemoteOrder: Decodable {
    let id: Int
    let status: String
    let totalCents: Int
}

/// The shop answered with an error: `status` and its message.
struct ApiError: Error {
    let status: Int
    let message: String
}

/// The shop couldn't be reached, or sent something that isn't JSON.
struct NetworkError: Error {}

/// The login, kept with the app's data so it survives a restart.
final class Session {
    private let defaults = UserDefaults.standard

    var cookie: String? {
        get { defaults.string(forKey: "cookie") }
        set { defaults.set(newValue, forKey: "cookie") }
    }
}

/// The zoo shop's JSON API.
final class ShopApi {
    private let baseURL: URL
    private let session: Session
    private let urlSession: URLSession

    init(baseURL: URL, session: Session) {
        self.baseURL = baseURL
        self.session = session
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.urlCache = nil
        config.timeoutIntervalForRequest = 30
        urlSession = URLSession(configuration: config)
    }

    var loggedIn: Bool { session.cookie != nil }

    func login(email: String, password: String) async throws {
        let _: Empty = try await call("POST", "/api/session", body: ["email": email, "password": password])
    }

    func products() async throws -> [Product] {
        let body: ProductList = try await call("GET", "/api/products")
        return body.products
    }

    /// Adds one of a product to the open cart; returns how many items the cart holds.
    func addToCart(productId: Int) async throws -> Int {
        let body: Count = try await call("POST", "/api/cart/items", body: ["productId": productId, "quantity": 1])
        return body.count
    }

    func cart() async throws -> Cart {
        try await call("GET", "/api/cart")
    }

    /// Checks out the cart the user is looking at; returns the order's id.
    func pay(cartId: Int) async throws -> Int {
        let body: Placed = try await call("POST", "/api/orders", body: ["cartId": cartId])
        return body.orderId
    }

    /// `pending`, `processing`, `paid` or `failed`.
    func orderStatus(_ id: Int) async throws -> String {
        let body: Status = try await call("GET", "/api/orders/\(id)")
        return body.status
    }

    /// The user's orders, newest first.
    func orders() async throws -> [RemoteOrder] {
        let body: OrderList = try await call("GET", "/api/orders")
        return body.orders
    }

    private func call<T: Decodable>(_ method: String, _ path: String, body: [String: Any]? = nil) async throws -> T {
        var request = URLRequest(url: URL(string: baseURL.absoluteString.trimmingCharacters(in: ["/"]) + path)!)
        request.httpMethod = method
        request.httpShouldHandleCookies = false
        request.setValue("application/json", forHTTPHeaderField: "accept")
        if let cookie = session.cookie { request.setValue(cookie, forHTTPHeaderField: "cookie") }
        if let body {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            request.setValue("application/json", forHTTPHeaderField: "content-type")
        }
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await urlSession.data(for: request)
        } catch {
            throw NetworkError()
        }
        guard let http = response as? HTTPURLResponse else { throw NetworkError() }
        let headers = http.allHeaderFields as? [String: String] ?? [:]
        if let sid = HTTPCookie.cookies(withResponseHeaderFields: headers, for: request.url!).first(where: { $0.name == "sid" }) {
            session.cookie = "sid=\(sid.value)"
        }
        if http.statusCode == 401 { session.cookie = nil }
        if http.statusCode >= 400 {
            let message = (try? JSONDecoder().decode(ErrorBody.self, from: data))?.error ?? "The shop answered \(http.statusCode)"
            throw ApiError(status: http.statusCode, message: message)
        }
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw NetworkError()
        }
    }
}

private struct Empty: Decodable {}
private struct ErrorBody: Decodable { let error: String }
private struct ProductList: Decodable { let products: [Product] }
private struct Count: Decodable { let count: Int }
private struct Placed: Decodable { let orderId: Int }
private struct Status: Decodable { let status: String }
private struct OrderList: Decodable { let orders: [RemoteOrder] }
