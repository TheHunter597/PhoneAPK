# ProGuard rules for the release build.
# We don't enable minification by default (minifyEnabled=false in build.gradle),
# but these rules ensure that if the user turns it on, the app still works.

# Keep nodejs-mobile-react-native classes (they use reflection to find native methods).
-keep class com.reactnativecommunity.nodejsmobile.** { *; }

# Keep React Native core (RN ships its own consumer rules, but add safety).
-keep class com.facebook.react.** { *; }
-keep class com.facebook.hermes.** { *; }
-dontwarn com.facebook.hermes.**

# Keep @react-native-documents/picker
-keep class com.reactnativedocumentpicker.** { *; }

# Keep react-native-webview
-keep class com.reactnativecommunity.webview.** { *; }

# Keep @react-native-async-storage/async-storage
-keep class com.reactnativecommunity.asyncstorage.** { *; }

# Keep our own SafSync native module.
-keep class com.obsidian.server.** { *; }
