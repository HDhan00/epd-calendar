plugins {
    id("com.android.application")
}

android {
    namespace = "com.dsh.trafficmon"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.dsh.trafficmon"
        minSdk = 26
        targetSdk = 34
        // 云端构建版本：versionCode 必须大于已装的 7，否则覆盖安装会被拒
        versionCode = 8
        versionName = "3.1-cloud"
    }

    // 用仓库里自带的 debug.keystore 签名。
    // 它的证书指纹 DA:A5:A0:97:… 与手机上已装的 v3.1 完全一致，
    // 所以云端产出的 APK 可以覆盖安装，不需要卸载（卸载会丢 SharedPreferences）。
    signingConfigs {
        create("shared") {
            storeFile = rootProject.file("debug.keystore")
            storePassword = "android"
            keyAlias = "debug"
            keyPassword = "android"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("shared")
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
        debug {
            signingConfig = signingConfigs.getByName("shared")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

// 无第三方依赖：只用 Android 框架 API
dependencies {
}
