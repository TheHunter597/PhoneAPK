plugins {
    id("com.android.application")
    id("com.facebook.react")
}

react {
    // The RN Gradle Plugin reads node_modules/ from this root.
    root = file("../../")
    // Bundle command for release builds.
    bundleCommand = "bundle-android"
    // autolinkLibraries is applied by the plugin automatically (RN 0.71+).
    // It reads node_modules metadata and wires up all native deps.
}

android {
    ndkVersion = "27.1.12297006"

    compileSdkVersion = 35
    buildToolsVersion = "35.0.0"

    namespace = "com.obsidian.server"
    defaultConfig {
        applicationId = "com.obsidian.server"
        minSdkVersion = 24
        targetSdkVersion = 35
        versionCode = 1
        versionName = "1.0.0"

        // nodejs-mobile ships native Node binaries for these ABIs.
        //   arm64-v8a → all modern Android phones (≥99% of devices)
        //   x86_64    → Android emulator / ChromeOS
        // We exclude armeabi-v7a and x86 (32-bit) to keep the APK small and
        // because @img/sharp-wasm32 doesn't ship prebuilts for them either.
        ndk {
            abiFilters += listOf("arm64-v8a", "x86_64")
        }

        // Explicitly declare the BuildConfig fields read by MainApplication.kt.
        // RN's gradle plugin also generates these, but we set them here too so
        // the build is robust against plugin version drift.
        buildConfigField("boolean", "IS_NEW_ARCHITECTURE_ENABLED", "true")
        buildConfigField("boolean", "IS_HERMES_ENABLED", "true")
    }

    // Sign debug with the bundled debug keystore (RN default).
    // Sign release with a user-provided keystore (see android/keystore.properties).
    signingConfigs {
        getByName("debug") {
            storeFile = file("debug.keystore")
            storePassword = "android"
            keyAlias = "androiddebugkey"
            keyPassword = "android"
        }
        create("release") {
            val ks = file("keystore.properties")
            if (ks.exists()) {
                val p = java.util.Properties()
                p.load(ks.inputStream())
                storeFile = file(p.getProperty("storeFile"))
                storePassword = p.getProperty("storePassword")
                keyAlias = p.getProperty("keyAlias")
                keyPassword = p.getProperty("keyPassword")
            } else {
                // No keystore.properties — fall back to debug signing so the
                // APK is still installable during development.
                storeFile = file("debug.keystore")
                storePassword = "android"
                keyAlias = "androiddebugkey"
                keyPassword = "android"
            }
        }
    }

    buildTypes {
        debug {
            signingConfig = signingConfigs.getByName("debug")
            isMinifyEnabled = false
            isDebuggable = true
        }
        release {
            signingConfig = signingConfigs.getByName("release")
            isMinifyEnabled = false
            isShrinkResources = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    packaging {
        resources {
            excludes += setOf(
                "META-INF/DEPENDENCIES",
                "META-INF/LICENSE",
                "META-INF/LICENSE.txt",
                "META-INF/license.txt",
                "META-INF/NOTICE",
                "META-INF/NOTICE.txt",
                "META-INF/notice.txt",
                "META-INF/ASL2.0",
                "META-INF/*.kotlin_module",
            )
        }
        // Force-resolve libc++_shared.so conflicts (nodejs-mobile vs RN).
        jniLibs {
            pickFirsts += setOf("**/libc++_shared.so", "**/libfbjni.so")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }

    // Expose BuildConfig flags consumed by MainApplication.kt.
    buildFeatures {
        buildConfig = true
    }
}

dependencies {
    // React Native core, Hermes engine, nodejs-mobile-react-native,
    // @react-native-documents/picker, react-native-webview, and
    // @react-native-async-storage/async-storage are all autolinked by the
    // RN Gradle Plugin's `react {}` block above. No manual dependency
    // declarations needed.
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
}
