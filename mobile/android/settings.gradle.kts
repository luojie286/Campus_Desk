pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories { google(); mavenCentral() }
}
rootProject.name = "CampusDeskMobile"
include(":app")
// 独立技术验证包，仅显式启用时参与构建，不改正式 App 的依赖。
if (providers.gradleProperty("tsnetProbe").orNull == "true") include(":tsnetProbe")
