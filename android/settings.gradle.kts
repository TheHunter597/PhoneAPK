// settings.gradle.kts — RN 0.86 + new plugins DSL setup.
//
// pluginManagement: tell Gradle where to find the RN Gradle Plugin
// (it's a composite build inside node_modules) and configure version
// resolution for AGP / Kotlin.
pluginManagement {
    includeBuild("node_modules/@react-native/gradle-plugin")
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

// Apply the RN settings plugin (sets up autolinking).
plugins {
    id("com.facebook.react.settings")
}

extensions.configure<com.facebook.react.ReactSettingsExtension> {
    autolinkLibraries(appProject)
}

rootProject.name = "ObsidianServer"
include(":app")
includeBuild("node_modules/@react-native/gradle-plugin")
