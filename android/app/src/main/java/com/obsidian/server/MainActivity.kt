package com.obsidian.server

import android.content.Intent
import android.os.Bundle
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint
import com.facebook.react.defaults.DefaultReactActivityDelegate

/**
 * Main activity — host for the React Native root.
 *
 * The actual UI (WebView, vault picker, etc.) is rendered by React Native.
 * We only handle launch + configuration changes here.
 */
class MainActivity : ReactActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
    }

    /**
     * Returns the name of the main React component registered from JS
     * (see index.js → AppRegistry.registerComponent('ObsidianServer', () => App)).
     */
    override fun getMainComponentName(): String = "ObsidianServer"

    /**
     * Use the new architecture delegate (RN 0.74+) so the new Fabric
     * renderer + TurboModules are enabled when the user opts in via
     * gradle.properties (newArchEnabled=true).
     */
    override fun createReactActivityDelegate(): ReactActivityDelegate =
        DefaultReactActivityDelegate(
            this,
            mainComponentName,
            DefaultNewArchitectureEntryPoint.bridgelessEnabled,
            DefaultNewArchitectureEntryPoint.isBridgelessArchitectureEnabled,
        )
}
