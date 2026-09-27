pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    // Global init scripts may add project repositories; keep using the settings
    // repositories without failing configuration on those machine-local additions.
    repositoriesMode.set(RepositoriesMode.PREFER_SETTINGS)
    repositories {
        google()
        mavenCentral()
    }
}
rootProject.name = "SteamChatAndroid"
include(":app")
