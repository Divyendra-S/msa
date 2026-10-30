package dev.windtunnel.shop

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import java.io.IOException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

enum class Screen { Login, Products, Cart, Order }

/** The shop's state. It lives in a ViewModel, so a rotation or a trip to the background keeps it. */
class ShopViewModel(private val api: ShopApi) : ViewModel() {
    var screen by mutableStateOf(if (api.loggedIn) Screen.Products else Screen.Login)
        private set

    /** Where to go once logged in: the screen the session ran out on. */
    private var afterLogin = Screen.Products

    var loggingIn by mutableStateOf(false)
        private set
    var loginError by mutableStateOf<String?>(null)
        private set

    var products by mutableStateOf<List<Product>>(emptyList())
        private set
    var adding by mutableStateOf<Set<Int>>(emptySet())
        private set
    var added by mutableStateOf<Set<Int>>(emptySet())
        private set
    var productsError by mutableStateOf<String?>(null)
        private set

    var cart by mutableStateOf<Cart?>(null)
        private set
    var paying by mutableStateOf(false)
        private set
    var payError by mutableStateOf<String?>(null)
        private set

    var orderId by mutableStateOf<Int?>(null)
        private set
    var orderStatus by mutableStateOf("pending")
        private set
    private var polling: Job? = null

    init {
        if (screen == Screen.Products) loadProducts()
    }

    fun login(email: String, password: String) {
        loggingIn = true
        loginError = null
        viewModelScope.launch {
            try {
                io { api.login(email, password) }
                open(afterLogin)
            } catch (err: ApiException) {
                loginError = err.message
            } catch (err: IOException) {
                loginError = "Network error. Please try again."
            } finally {
                loggingIn = false
            }
        }
    }

    fun open(target: Screen) {
        screen = target
        when (target) {
            Screen.Products -> loadProducts()
            Screen.Cart -> loadCart()
            Screen.Order -> pollOrder()
            Screen.Login -> Unit
        }
    }

    /** Back from a screen; false when there's nowhere to go back to (leave the app). */
    fun back(): Boolean {
        if (screen == Screen.Cart || screen == Screen.Order) {
            open(Screen.Products)
            return true
        }
        return false
    }

    fun addToCart(product: Product) {
        adding = adding + product.id
        productsError = null
        viewModelScope.launch {
            try {
                io { api.addToCart(product.id) }
                added = added + product.id
            } catch (err: ApiException) {
                if (err.status == 401) return@launch logInAgain(Screen.Products)
                productsError = "Could not add ${product.name}"
            } catch (err: IOException) {
                productsError = "Network error. Please try again."
            } finally {
                adding = adding - product.id
            }
        }
    }

    fun pay() {
        val cartId = cart?.id ?: return
        paying = true
        payError = null
        viewModelScope.launch {
            try {
                orderId = io { api.pay(cartId) }
                orderStatus = "processing"
                open(Screen.Order)
            } catch (err: ApiException) {
                if (err.status == 401) return@launch logInAgain(Screen.Cart)
                payError = err.message
            } catch (err: IOException) {
                payError = "Network error. Please try again."
            } finally {
                paying = false
            }
        }
    }

    private fun loadProducts() {
        viewModelScope.launch {
            try {
                products = io { api.products() }
            } catch (err: ApiException) {
                productsError = err.message
            } catch (err: IOException) {
                productsError = "Network error. Please try again."
            }
        }
    }

    private fun loadCart() {
        cart = null
        payError = null
        viewModelScope.launch {
            try {
                cart = io { api.cart() }
            } catch (err: ApiException) {
                if (err.status == 401) logInAgain(Screen.Cart) else payError = err.message
            } catch (err: IOException) {
                payError = "Network error. Please try again."
            }
        }
    }

    /** Asks for the order's status until the payment settles; the provider's webhook can take a while. */
    private fun pollOrder() {
        val id = orderId ?: return
        polling?.cancel()
        polling = viewModelScope.launch {
            while (screen == Screen.Order && orderStatus != "paid" && orderStatus != "failed") {
                delay(400)
                try {
                    orderStatus = io { api.orderStatus(id) }
                } catch (err: ApiException) {
                    if (err.status == 401) return@launch logInAgain(Screen.Order)
                } catch (err: IOException) {
                    // Try again on the next tick.
                }
            }
        }
    }

    private fun logInAgain(then: Screen) {
        afterLogin = then
        screen = Screen.Login
    }

    private suspend fun <T> io(block: () -> T): T = withContext(Dispatchers.IO) { block() }
}
