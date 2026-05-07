package com.example.sparkling.go

import android.app.Application
import com.lynx.tasm.LynxViewBuilder
import com.tiktok.sparkling.hybridkit.lynx.SparklingAutolinkRegistry

data class SparklingAutolinkModule(val name: String, val androidPackage: String?, val className: String?)

object SparklingAutolink {
    private var registered = false

    val modules = listOf(
        SparklingAutolinkModule(name = "sparkling-navigation", androidPackage = "com.tiktok.sparkling.methods.router", className = "RouterMethod")
    )

    @JvmStatic
    fun register(application: Application) {
        if (registered) return
        registered = true
        SparklingAutolinkRegistry.markGeneratedRegistered(application.packageName)
        // No native extensions discovered.
    }

    @JvmStatic
    fun configure(builder: LynxViewBuilder) {
        SparklingAutolinkRegistry.configure(builder)
    }
}
