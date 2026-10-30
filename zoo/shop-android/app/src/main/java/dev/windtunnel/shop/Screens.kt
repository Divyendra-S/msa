package dev.windtunnel.shop

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp

@Composable
fun ShopApp(model: ShopViewModel, onLeave: () -> Unit) {
    BackHandler { if (!model.back()) onLeave() }
    MaterialTheme {
        Surface(Modifier.fillMaxSize()) {
            Column(
                Modifier.safeDrawingPadding().padding(horizontal = 20.dp, vertical = 12.dp).verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                when (model.screen) {
                    Screen.Login -> LoginScreen(model)
                    Screen.Products -> ProductsScreen(model)
                    Screen.Cart -> CartScreen(model)
                    Screen.Order -> OrderScreen(model)
                }
            }
        }
    }
}

@Composable
private fun LoginScreen(model: ShopViewModel) {
    var email by rememberSaveable { mutableStateOf("") }
    var password by rememberSaveable { mutableStateOf("") }
    Text("Log in", style = MaterialTheme.typography.headlineMedium)
    OutlinedTextField(
        value = email,
        onValueChange = { email = it },
        label = { Text("Email") },
        singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
        modifier = Modifier.fillMaxWidth(),
    )
    OutlinedTextField(
        value = password,
        onValueChange = { password = it },
        label = { Text("Password") },
        singleLine = true,
        visualTransformation = PasswordVisualTransformation(),
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
        modifier = Modifier.fillMaxWidth(),
    )
    Button(onClick = { model.login(email, password) }, enabled = !model.loggingIn) { Text("Log in") }
    model.loginError?.let { Alert(it) }
}

@Composable
private fun ProductsScreen(model: ShopViewModel) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text("Products", style = MaterialTheme.typography.headlineMedium)
        Spacer(Modifier.weight(1f))
        TextButton(onClick = { model.open(Screen.Cart) }) { Text("Cart") }
    }
    model.productsError?.let { Alert(it) }
    for (product in model.products) {
        HorizontalDivider()
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Column(Modifier.weight(1f)) {
                Text(product.name, style = MaterialTheme.typography.titleMedium)
                val stock = if (product.stock > 0) "${product.stock} in stock" else "Sold out"
                Text("${price(product.priceCents)} · $stock", style = MaterialTheme.typography.bodySmall)
            }
            if (product.id in model.added) Text("Added", style = MaterialTheme.typography.bodySmall)
            if (product.stock > 0) {
                Button(
                    onClick = { model.addToCart(product) },
                    enabled = product.id !in model.adding,
                    // Read as "Add Ceramic Mug to cart", so each product's button has its own name.
                    modifier = Modifier.semantics { contentDescription = "Add ${product.name} to cart" },
                ) { Text("Add to cart") }
            }
        }
    }
}

@Composable
private fun CartScreen(model: ShopViewModel) {
    Text("Cart", style = MaterialTheme.typography.headlineMedium)
    val cart = model.cart
    when {
        cart == null -> Text(if (model.payError == null) "Loading…" else "")
        cart.items.isEmpty() -> Text("Your cart is empty.")
        else -> {
            for (item in cart.items) {
                Row {
                    Text(item.name, Modifier.weight(1f))
                    Text("${item.quantity} × ${price(item.priceCents)}")
                }
            }
            HorizontalDivider()
            Text("Total: ${price(cart.totalCents)}", style = MaterialTheme.typography.titleMedium)
            Button(onClick = model::pay, enabled = !model.paying) { Text(if (model.paying) "Paying…" else "Pay now") }
        }
    }
    model.payError?.let { Alert(it) }
}

@Composable
private fun OrderScreen(model: ShopViewModel) {
    Text("Order #${model.orderId}", style = MaterialTheme.typography.headlineMedium)
    val status = when (model.orderStatus) {
        "paid" -> "Order confirmed"
        "failed" -> "Payment failed"
        else -> "Processing payment…"
    }
    Text(status, style = MaterialTheme.typography.titleMedium, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
    TextButton(onClick = { model.open(Screen.Products) }) { Text("Keep shopping") }
}

@Composable
private fun Alert(text: String) {
    Text(
        text,
        color = MaterialTheme.colorScheme.error,
        modifier = Modifier.semantics { liveRegion = LiveRegionMode.Assertive },
    )
}

private fun price(cents: Int): String = "$%d.%02d".format(cents / 100, cents % 100)
