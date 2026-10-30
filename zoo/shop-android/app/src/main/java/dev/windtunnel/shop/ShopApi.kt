package dev.windtunnel.shop

import android.content.Context
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import org.json.JSONObject

class Product(val id: Int, val name: String, val priceCents: Int, val stock: Int)

class CartItem(val productId: Int, val name: String, val quantity: Int, val priceCents: Int)

class Cart(val id: Int?, val items: List<CartItem>, val totalCents: Int)

/** The shop answered with an error: `status` and its message. */
class ApiException(val status: Int, message: String) : Exception(message)

/** The login, kept with the app's data so it survives a restart. */
class Session(context: Context) {
    private val prefs = context.getSharedPreferences("session", Context.MODE_PRIVATE)

    var cookie: String?
        get() = prefs.getString("cookie", null)
        set(value) = prefs.edit().putString("cookie", value).apply()
}

/** The zoo shop's JSON API. Every call blocks: run them off the main thread. */
class ShopApi(private val baseUrl: String, private val session: Session) {
    val loggedIn: Boolean
        get() = session.cookie != null

    fun login(email: String, password: String) {
        call("POST", "/api/session", JSONObject().put("email", email).put("password", password))
    }

    fun products(): List<Product> {
        val list = call("GET", "/api/products").getJSONArray("products")
        return (0 until list.length()).map { i ->
            val p = list.getJSONObject(i)
            Product(p.getInt("id"), p.getString("name"), p.getInt("priceCents"), p.getInt("stock"))
        }
    }

    /** Adds one of a product to the open cart; returns how many items the cart holds. */
    fun addToCart(productId: Int): Int =
        call("POST", "/api/cart/items", JSONObject().put("productId", productId).put("quantity", 1)).getInt("count")

    fun cart(): Cart {
        val body = call("GET", "/api/cart")
        val list = body.getJSONArray("items")
        val items = (0 until list.length()).map { i ->
            val item = list.getJSONObject(i)
            CartItem(item.getInt("productId"), item.getString("name"), item.getInt("quantity"), item.getInt("priceCents"))
        }
        return Cart(if (body.isNull("cartId")) null else body.getInt("cartId"), items, body.getInt("totalCents"))
    }

    /** Checks out the cart the user is looking at; returns the order's id. */
    fun pay(cartId: Int): Int = call("POST", "/api/orders", JSONObject().put("cartId", cartId)).getInt("orderId")

    /** `pending`, `processing`, `paid` or `failed`. */
    fun orderStatus(orderId: Int): String = call("GET", "/api/orders/$orderId").getString("status")

    private fun call(method: String, path: String, body: JSONObject? = null): JSONObject {
        val connection = URL(baseUrl.trimEnd('/') + path).openConnection() as HttpURLConnection
        try {
            connection.requestMethod = method
            connection.connectTimeout = 10_000
            connection.readTimeout = 30_000
            connection.instanceFollowRedirects = false
            connection.setRequestProperty("accept", "application/json")
            session.cookie?.let { connection.setRequestProperty("cookie", it) }
            if (body != null) {
                val bytes = body.toString().toByteArray()
                connection.doOutput = true
                connection.setRequestProperty("content-type", "application/json")
                // A streamed body can't be sent again, so a dropped connection is an error the
                // user sees, never a second checkout the app sends on its own.
                connection.setFixedLengthStreamingMode(bytes.size)
                connection.outputStream.use { it.write(bytes) }
            }
            val status = connection.responseCode
            connection.headerFields["Set-Cookie"]
                ?.firstOrNull { it.startsWith("sid=") }
                ?.let { session.cookie = it.substringBefore(';') }
            val text = (if (status < 400) connection.inputStream else connection.errorStream)
                ?.bufferedReader()
                ?.use { it.readText() }
                .orEmpty()
            val json = if (text.isBlank()) JSONObject() else JSONObject(text)
            if (status == 401) session.cookie = null
            if (status >= 400) throw ApiException(status, json.optString("error", "The shop answered $status"))
            return json
        } catch (err: org.json.JSONException) {
            throw IOException("The shop sent something that isn't JSON", err)
        } finally {
            connection.disconnect()
        }
    }
}
