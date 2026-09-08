plugins {
    id("com.android.application") version "8.13.2" apply false
    id("org.jetbrains.kotlin.android") version "2.1.20" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.1.20" apply false
}

// Optional external build output for constrained CI/workstations.
System.getenv("STEAM_CHAT_ANDROID_BUILD_DIR")?.let { output ->
    allprojects { layout.buildDirectory.set(file("$output/${project.name}")) }
}
