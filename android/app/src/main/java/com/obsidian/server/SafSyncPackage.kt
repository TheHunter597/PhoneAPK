package com.obsidian.server

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

/**
 * React Native package that registers SafSyncModule with the bridge.
 *
 * Wired up in MainApplication.kt → PackageList(this).packages.apply { add(SafSyncPackage()) }.
 *
 * NOTE: RN 0.86's ReactPackage interface deprecates `createNativeModules` in
 * favor of BaseReactPackage + getModule(name, ctx), but the deprecated path
 * still works for non-TurboModule native modules like ours. We use it for
 * backwards compatibility.
 */
class SafSyncPackage : ReactPackage {
    @Suppress("DEPRECATION")
    override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
        listOf(SafSyncModule(reactContext))

    override fun createViewManagers(
        reactContext: ReactApplicationContext
    ): List<ViewManager<in Nothing, in Nothing>> = emptyList()
}
