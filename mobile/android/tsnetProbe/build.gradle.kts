plugins { id("com.android.application") }
android {
    namespace = "com.campusdesk.tsnetprobe"
    compileSdk = 36
    defaultConfig {
        applicationId = "com.campusdesk.tsnetprobe"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "0.1-probe"
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
dependencies { implementation(files("libs/probe.aar")) }
