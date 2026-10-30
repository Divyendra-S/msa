package dev.windtunnel.shop

import android.content.Context
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.lifecycle.viewmodel.compose.viewModel

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val api = ShopApi(apiUrl(), Session(applicationContext))
        setContent {
            val model = viewModel { ShopViewModel(api) }
            ShopApp(model, onLeave = ::finish)
        }
    }

    /**
     * Where the shop's API is: the `apiUrl` launch extra (`am start … --es apiUrl http://…`), kept
     * for later launches that don't pass it. Without one, the emulator's address for this machine.
     */
    private fun apiUrl(): String {
        val prefs = getSharedPreferences("settings", Context.MODE_PRIVATE)
        intent.getStringExtra("apiUrl")?.let { prefs.edit().putString("apiUrl", it).apply() }
        return prefs.getString("apiUrl", null) ?: "http://10.0.2.2:3000"
    }
}
