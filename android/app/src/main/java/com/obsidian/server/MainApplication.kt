package com.obsidian.server

import android.app.Application
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost

/**
 * Main Application class.
 *
 * Wires up React Native + autolinked native packages + our own SafSync
 * native package (which exposes the SAF tree-copy / export functions to JS).
 *
 * NOTE: This is the RN 0.86 API. Previous versions of RN used a
 * ReactNativeHost + SoLoader.init + DefaultNewArchitectureEntryPoint.load()
 * pattern, but RN 0.86 deprecated those in favor of the simpler
 * `loadReactNative(this)` + `getDefaultReactHost(...)` pattern.
 */
class MainApplication : Application(), ReactApplication {

    override val reactHost: ReactHost by lazy {
        getDefaultReactHost(
            context = applicationContext,
            packageList =
                PackageList(this).packages.apply {
                    // Register our own native package so SafSync is reachable from JS.
                    // Autolinked packages are added automatically; we just append ours.
                    add(SafSyncPackage())
                },
        )
    }

    override fun onCreate() {
        super.onCreate()
        loadReactNative(this)
    }
}
