plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.cencyzp.ncestudyfree.tts"
    compileSdk = 34

    defaultConfig {
        minSdk = 24
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    // tauri-android 工程由 `cargo tauri android init` 生成的根 gradle 提供（tools/android-patch.mjs 会并入本工程）
    implementation(project(":tauri-android"))
    implementation("androidx.annotation:annotation:1.8.0")
}
