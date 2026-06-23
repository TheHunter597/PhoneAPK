// Top-level build file for RN 0.86 with new plugins DSL.
//
// Plugins are declared here with `apply false`, then applied in the
// app/build.gradle.kts module. The React Native Gradle Plugin is included
// via the includeBuild() call in settings.gradle.kts.
plugins {
    id("com.android.application") apply false
    id("org.jetbrains.kotlin.android") apply false
    id("com.facebook.react") apply false
}
