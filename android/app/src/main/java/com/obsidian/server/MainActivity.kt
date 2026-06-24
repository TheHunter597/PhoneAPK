package com.obsidian.server

import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

/**
 * Main activity — host for the React Native root.
 *
 * The actual UI (WebView, vault picker, etc.) is rendered by React Native.
 * We only handle launch + configuration changes here.
 *
 * NOTE: With `newArchEnabled=false` in gradle.properties, `fabricEnabled`
 * returns false, so the DefaultReactActivityDelegate runs in legacy bridge
 * mode — which is what nodejs-mobile-react-native v18.20.4 requires.
 *
 * RN 0.86's DefaultReactActivityDelegate takes 3 args:
 *   (this, mainComponentName, fabricEnabled)
 * Previous RN versions used 4 args (with bridgelessEnabled + isBridgeless)
 * which no longer compile in 0.86.
 */
class MainActivity : ReactActivity() {

    /**
     * Returns the name of the main React component registered from JS
     * (see index.js → AppRegistry.registerComponent('ObsidianServer', () => App)).
     */
    override fun getMainComponentName(): String = "ObsidianServer"

    /**
     * Returns the instance of the [ReactActivityDelegate]. We use
     * [DefaultReactActivityDelegate] which allows you to enable New
     * Architecture with a single boolean flag [fabricEnabled].
     */
    override fun createReactActivityDelegate(): ReactActivityDelegate =
        DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)
}
