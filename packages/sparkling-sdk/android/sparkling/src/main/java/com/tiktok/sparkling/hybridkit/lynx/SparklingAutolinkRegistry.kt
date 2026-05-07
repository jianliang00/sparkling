// Copyright (c) 2026 TikTok Pte. Ltd.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.
package com.tiktok.sparkling.hybridkit.lynx

import android.app.Application
import android.util.Log
import com.lynx.jsbridge.LynxModule
import com.lynx.tasm.LynxEnv
import com.lynx.tasm.LynxViewBuilder
import com.lynx.tasm.behavior.Behavior
import com.lynx.tasm.behavior.LynxContext
import com.lynx.tasm.behavior.ui.LynxUI
import com.lynx.tasm.service.IServiceProvider
import com.lynx.tasm.service.LynxServiceCenter
import com.tiktok.sparkling.method.registry.core.IDLBridgeMethod
import com.tiktok.sparkling.method.registry.core.SparklingBridgeManager

object SparklingAutolinkRegistry {
    private const val TAG = "SparklingAutolink"

    private data class ElementRegistration(val name: String, val className: String)
    private data class NativeModuleRegistration(val name: String, val className: String)

    private val elements = linkedMapOf<String, ElementRegistration>()
    private val globalModules = linkedMapOf<String, NativeModuleRegistration>()
    private val viewModules = linkedMapOf<String, NativeModuleRegistration>()
    private val services = linkedSetOf<String>()
    private val sparklingMethods = linkedSetOf<String>()
    private val appliedServices = linkedSetOf<String>()
    private val appliedGlobalModules = linkedSetOf<String>()
    private val appliedSparklingMethods = linkedSetOf<String>()

    @Volatile
    private var generatedLoadAttempted = false

    @Volatile
    private var generatedRegisteredPackage: String? = null

    fun loadGenerated(application: Application?) {
        if (application == null || generatedLoadAttempted || generatedRegisteredPackage != null) {
            return
        }
        generatedLoadAttempted = true
        val registryClassName = "${application.packageName}.SparklingAutolink"
        runCatching {
            val registryClass = Class.forName(registryClassName)
            registryClass.getMethod("register", Application::class.java).invoke(null, application)
        }.onFailure {
            Log.d(TAG, "No generated SparklingAutolink found at $registryClassName")
        }
    }

    fun markGeneratedRegistered(packageName: String) {
        generatedRegisteredPackage = packageName
    }

    @Synchronized
    fun registerElement(name: String, className: String) {
        elements["$name:$className"] = ElementRegistration(name, className)
    }

    @Synchronized
    fun registerGlobalModule(name: String, className: String) {
        globalModules["$name:$className"] = NativeModuleRegistration(name, className)
    }

    @Synchronized
    fun registerViewModule(name: String, className: String) {
        viewModules["$name:$className"] = NativeModuleRegistration(name, className)
    }

    @Synchronized
    fun registerService(className: String) {
        services.add(className)
    }

    @Synchronized
    fun registerSparklingMethod(className: String) {
        sparklingMethods.add(className)
    }

    fun createBehaviors(): List<Behavior> {
        val registrations = synchronized(this) { elements.values.toList() }
        return registrations.mapNotNull { registration ->
            val uiClass = loadUiClass(registration.className) ?: return@mapNotNull null
            object : Behavior(registration.name, false) {
                override fun createUI(context: LynxContext?): LynxUI<*>? {
                    return runCatching {
                        val constructor = uiClass.getDeclaredConstructor(LynxContext::class.java)
                        constructor.isAccessible = true
                        constructor.newInstance(context)
                    }.onFailure {
                        Log.w(TAG, "Failed to create autolink element ${registration.name}", it)
                    }.getOrNull()
                }
            }
        }
    }

    fun applyGlobal() {
        applyServices()
        applyGlobalModules()
        applySparklingMethods()
    }

    fun configure(builder: LynxViewBuilder) {
        val registrations = synchronized(this) { viewModules.values.toList() }
        registrations.forEach { registration ->
            val moduleClass = loadLynxModuleClass(registration.className) ?: return@forEach
            runCatching {
                builder.registerModule(registration.name, moduleClass, null)
            }.onFailure {
                Log.w(TAG, "Failed to register autolink view module ${registration.name}", it)
            }
        }
    }

    private fun applyServices() {
        val pending = synchronized(this) { services.filter { appliedServices.add(it) } }
        pending.forEach { className ->
            val service = instantiateService(className) ?: return@forEach
            runCatching {
                LynxServiceCenter.inst().registerService(service)
            }.onFailure {
                Log.w(TAG, "Failed to register autolink service $className", it)
            }
        }
    }

    private fun applyGlobalModules() {
        val pending = synchronized(this) {
            globalModules.values.filter { appliedGlobalModules.add("${it.name}:${it.className}") }
        }
        pending.forEach { registration ->
            val moduleClass = loadLynxModuleClass(registration.className) ?: return@forEach
            runCatching {
                LynxEnv.inst().registerModule(registration.name, moduleClass, null)
            }.onFailure {
                Log.w(TAG, "Failed to register autolink global module ${registration.name}", it)
            }
        }
    }

    private fun applySparklingMethods() {
        val pending = synchronized(this) { sparklingMethods.filter { appliedSparklingMethods.add(it) } }
        pending.forEach { className ->
            val methodClass = loadClass(className)?.asSubclass(IDLBridgeMethod::class.java) ?: return@forEach
            runCatching {
                SparklingBridgeManager.registerIDLMethod(methodClass)
            }.onFailure {
                Log.w(TAG, "Failed to register autolink Sparkling method $className", it)
            }
        }
    }

    private fun instantiate(className: String): Any? {
        val clazz = loadClass(className) ?: return null
        runCatching {
            return clazz.getField("INSTANCE").get(null)
        }
        return runCatching {
            val constructor = clazz.getDeclaredConstructor()
            constructor.isAccessible = true
            constructor.newInstance()
        }.onFailure {
            Log.w(TAG, "Failed to instantiate $className", it)
        }.getOrNull()
    }

    private fun instantiateService(className: String): IServiceProvider? {
        val service = instantiate(className)
        if (service is IServiceProvider) {
            return service
        }
        Log.w(TAG, "Autolink service $className does not implement IServiceProvider")
        return null
    }

    @Suppress("UNCHECKED_CAST")
    private fun loadUiClass(className: String): Class<out LynxUI<*>>? {
        return runCatching {
            loadClass(className)?.asSubclass(LynxUI::class.java) as? Class<out LynxUI<*>>
        }.onFailure {
            Log.w(TAG, "Failed to load autolink element class $className", it)
        }.getOrNull()
    }

    private fun loadLynxModuleClass(className: String): Class<out LynxModule>? {
        return runCatching {
            loadClass(className)?.asSubclass(LynxModule::class.java)
        }.onFailure {
            Log.w(TAG, "Failed to load autolink module class $className", it)
        }.getOrNull()
    }

    private fun loadClass(className: String): Class<*>? {
        return runCatching {
            Class.forName(className)
        }.onFailure {
            Log.w(TAG, "Failed to load autolink class $className", it)
        }.getOrNull()
    }
}
