// Top-level build file. React Native 0.86 uses the new Gradle plugin DSL.
buildscript {
    repositories {
        google()
        mavenCentral()
    }
    dependencies {
        classpath("com.android.tools.build:gradle:8.7.0")
        classpath("com.facebook.react:react-native-gradle-plugin")
        // NOTE: Do not place your application dependencies here; they belong
        // in the individual module build.gradle files.
    }
}

allprojects {
    repositories {
        maven { url = uri("https://maven.google.com") }
        google()
        mavenCentral()
        maven { url = uri("https://www.jitpack.io") }
        // nodejs-mobile-react-native publishes its native AAR via mavenCentral
        // as well, so no special repo is needed.
    }
}
