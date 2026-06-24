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
 * NOTE: This is the RN 0.86 API. `loadReactNative(this)` sets up the React
 * host. With `newArchEnabled=false` in gradle.properties, the host runs in
 * legacy bridge mode (which is what nodejs-mobile-react-native v18.20.4
 * requires — it's not a TurboModule).
 *
 * Our custom SafSyncPackage is appended to PackageList(this).packages so
 * it's reachable from JS via NativeModules.SafSync.
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
