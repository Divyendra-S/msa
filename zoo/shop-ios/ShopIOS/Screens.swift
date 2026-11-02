import SwiftUI

struct ShopView: View {
    let model: ShopModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                switch model.screen {
                case .login: LoginScreen(model: model)
                case .products: ProductsScreen(model: model)
                case .cart: CartScreen(model: model)
                case .order: OrderScreen(model: model)
                case .orders: OrdersScreen(model: model)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 20)
            .padding(.vertical, 12)
        }
    }
}

private struct LoginScreen: View {
    let model: ShopModel
    @State private var email = ""
    @State private var password = ""

    var body: some View {
        Text("Log in").font(.largeTitle.bold())
        TextField("Email", text: $email)
            .keyboardType(.emailAddress)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .textFieldStyle(.roundedBorder)
        SecureField("Password", text: $password)
            .textFieldStyle(.roundedBorder)
        Button("Log in") { model.login(email: email, password: password) }
            .buttonStyle(.borderedProminent)
            .disabled(model.loggingIn)
        if let error = model.loginError { AlertText(error) }
    }
}

private struct ProductsScreen: View {
    let model: ShopModel

    var body: some View {
        HStack {
            Text("Products").font(.largeTitle.bold())
            Spacer()
            Button("Orders") { model.open(.orders) }
            Button("Cart") { model.open(.cart) }
        }
        if let error = model.productsError { AlertText(error) }
        ForEach(model.products) { product in
            Divider()
            HStack(spacing: 8) {
                VStack(alignment: .leading) {
                    Text(product.name).font(.headline)
                    Text("\(price(product.priceCents)) · \(product.stock > 0 ? "\(product.stock) in stock" : "Sold out")")
                        .font(.footnote)
                }
                Spacer()
                if model.added.contains(product.id) { Text("Added").font(.footnote) }
                if product.stock > 0 {
                    Button("Add to cart") { model.addToCart(product) }
                        .buttonStyle(.bordered)
                        .disabled(model.adding.contains(product.id))
                        // Read as "Add Ceramic Mug to cart", so each product's button has its own name.
                        .accessibilityLabel("Add \(product.name) to cart")
                }
            }
        }
    }
}

private struct CartScreen: View {
    let model: ShopModel

    var body: some View {
        Button("Back") { model.open(.products) }
        Text("Cart").font(.largeTitle.bold())
        if let cart = model.cart {
            if cart.items.isEmpty {
                Text("Your cart is empty.")
            } else {
                ForEach(cart.items, id: \.productId) { item in
                    HStack {
                        Text(item.name)
                        Spacer()
                        Text("\(item.quantity) × \(price(item.priceCents))")
                    }
                }
                Divider()
                Text("Total: \(price(cart.totalCents))").font(.headline)
                Button(model.paying ? "Paying…" : "Pay now") { model.pay() }
                    .buttonStyle(.borderedProminent)
                    .disabled(model.paying)
            }
        } else if model.payError == nil {
            Text("Loading…")
        }
        if let error = model.payError { AlertText(error) }
    }
}

private struct OrderScreen: View {
    let model: ShopModel

    var body: some View {
        Text("Order #\(model.orderId ?? 0)").font(.largeTitle.bold())
        Text(statusText(model.orderStatus))
            .font(.headline)
            .accessibilityAddTraits(.updatesFrequently)
        Button("Keep shopping") { model.open(.products) }
    }
}

private struct OrdersScreen: View {
    let model: ShopModel

    var body: some View {
        Button("Back") { model.open(.products) }
        Text("Your orders").font(.largeTitle.bold())
        if model.orders.isEmpty { Text("No orders yet.") }
        ForEach(model.orders, id: \.orderId) { order in
            HStack {
                Text("Order #\(order.orderId)")
                Spacer()
                Text(statusText(order.status)).font(.footnote)
            }
        }
    }
}

/// An error or status the app announces.
private struct AlertText: View {
    let text: String

    init(_ text: String) {
        self.text = text
    }

    var body: some View {
        Text(text)
            .foregroundStyle(.red)
            .accessibilityAddTraits(.updatesFrequently)
    }
}

private func statusText(_ status: String) -> String {
    switch status {
    case "paid": "Order confirmed"
    case "failed": "Payment failed"
    default: "Processing payment…"
    }
}

private func price(_ cents: Int) -> String {
    String(format: "$%d.%02d", cents / 100, cents % 100)
}
