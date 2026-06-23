pluginManagement { includeBuild("node_modules/@react-native/gradle-plugin") }
plugins { id("com.android.application") apply false }
plugins { id("com.facebook.react") version "0.86.0" apply false }

rootProject.name = "ObsidianServer"
include(":app")
includeBuild("node_modules/@react-native/gradle-plugin")
