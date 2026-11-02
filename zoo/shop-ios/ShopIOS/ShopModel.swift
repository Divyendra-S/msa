import Foundation
import Observation

enum Screen {
    case login, products, cart, order, orders
}

/// The shop's state. A restart starts it again from the login kept on the phone.
@Observable
final class ShopModel {
    private let api: ShopApi
    private let history: OrderHistory

    private(set) var screen: Screen
    /// Where to go once logged in: the screen the session ran out on.
    private var afterLogin = Screen.products

    private(set) var loggingIn = false
    private(set) var loginError: String?

    private(set) var products: [Product] = []
    private(set) var adding: Set<Int> = []
    private(set) var added: Set<Int> = []
    private(set) var productsError: String?

    private(set) var cart: Cart?
    private(set) var paying = false
    private(set) var payError: String?

    private(set) var orderId: Int?
    private(set) var orderStatus = "pending"
    private var polling: Task<Void, Never>?

    /// The orders kept on the phone, for the Orders screen.
    private(set) var orders: [HistoryEntry] = []

    init(api: ShopApi, history: OrderHistory) {
        self.api = api
        self.history = history
        screen = api.loggedIn ? .products : .login
        if screen == .products { loadProducts() }
    }

    func login(email: String, password: String) {
        loggingIn = true
        loginError = nil
        Task {
            defer { loggingIn = false }
            do {
                try await api.login(email: email, password: password)
                open(afterLogin)
            } catch let err as ApiError {
                loginError = err.message
            } catch {
                loginError = "Network error. Please try again."
            }
        }
    }

    func open(_ target: Screen) {
        screen = target
        switch target {
        case .products: loadProducts()
        case .cart: loadCart()
        case .order: pollOrder()
        case .orders: loadOrders()
        case .login: break
        }
    }

    func addToCart(_ product: Product) {
        adding.insert(product.id)
        productsError = nil
        Task {
            defer { adding.remove(product.id) }
            do {
                _ = try await api.addToCart(productId: product.id)
                added.insert(product.id)
            } catch let err as ApiError {
                if err.status == 401 { return logInAgain(then: .products) }
                productsError = "Could not add \(product.name)"
            } catch {
                productsError = "Network error. Please try again."
            }
        }
    }

    /// Checks out the cart on screen, once: a second tap or link while paying does nothing.
    func pay() {
        guard !paying, let cart, let cartId = cart.cartId else { return }
        paying = true
        payError = nil
        Task {
            defer { paying = false }
            do {
                let id = try await api.pay(cartId: cartId)
                await history.record(orderId: id, status: "processing", totalCents: cart.totalCents)
                orderId = id
                orderStatus = "processing"
                open(.order)
            } catch let err as ApiError {
                if err.status == 401 { return logInAgain(then: .cart) }
                payError = err.message
            } catch {
                payError = "Network error. Please try again."
            }
        }
    }

    /// A link to the app: `shop://checkout` is where the payment page sends the user back, to place the order.
    func handle(url: URL) {
        guard url.scheme == "shop", url.host() == "checkout", screen != .login else { return }
        // Placed already: the order's screen says how the payment went.
        if screen == .order { return }
        if screen == .cart, cart != nil { return pay() }
        Task {
            screen = .cart
            await reloadCart()
            pay()
        }
    }

    /// A push from the shop: `event: orders-changed` brings the order history up to date.
    func handlePush(_ userInfo: [AnyHashable: Any]) {
        guard userInfo["event"] as? String == "orders-changed" else { return }
        Task {
            try? await history.refresh(from: api)
            if screen == .orders { orders = await history.all() }
        }
    }

    private func loadProducts() {
        Task {
            do {
                products = try await api.products()
            } catch let err as ApiError {
                productsError = err.message
            } catch {
                productsError = "Network error. Please try again."
            }
        }
    }

    private func loadCart() {
        Task { await reloadCart() }
    }

    private func reloadCart() async {
        cart = nil
        payError = nil
        do {
            cart = try await api.cart()
        } catch let err as ApiError {
            if err.status == 401 { logInAgain(then: .cart) } else { payError = err.message }
        } catch {
            payError = "Network error. Please try again."
        }
    }

    private func loadOrders() {
        Task { orders = await history.all() }
    }

    /// Asks for the order's status until the payment settles; the provider's webhook can take a while.
    private func pollOrder() {
        guard let id = orderId else { return }
        polling?.cancel()
        polling = Task {
            while screen == .order, orderStatus != "paid", orderStatus != "failed", !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(400))
                do {
                    orderStatus = try await api.orderStatus(id)
                    await history.update(orderId: id, status: orderStatus)
                } catch let err as ApiError {
                    if err.status == 401 { return logInAgain(then: .order) }
                } catch {
                    // Try again on the next tick.
                }
            }
        }
    }

    private func logInAgain(then target: Screen) {
        afterLogin = target
        screen = .login
    }
}
