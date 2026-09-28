import java.io.FileInputStream
import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Release signing material is owned by whoever runs the deploy pipeline,
// not by this repo — it is never committed. android/keystore.properties
// (git-ignored) supplies it locally when present, with keys
//   storeFile=<path to the .jks/.keystore, relative to android/app or absolute>
//   storePassword=...
//   keyAlias=...
//   keyPassword=...
// When the file is absent (every machine that isn't the release rig), the
// release build type falls back to the debug signing config below so
// `assembleRelease` still succeeds — it just produces a debug-signed APK,
// same as today, rather than failing the build.
val keystorePropertiesFile = rootProject.file("keystore.properties")
val keystoreProperties = Properties()
val hasReleaseKeystore = keystorePropertiesFile.exists()
if (hasReleaseKeystore) {
    keystoreProperties.load(FileInputStream(keystorePropertiesFile))
}

android {
    namespace = "org.forgesworn.kinjar"
    compileSdk = 36

    defaultConfig {
        // NAME-FREE by design — see internal plan 2026-08-11-android-apk
        // Global Constraints: applicationId, app label and any wire/storage-visible
        // string must not carry "Kinterest" until the name is settled at launch.
        applicationId = "org.forgesworn.kinjar"
        minSdk = 29
        targetSdk = 36
        versionCode = 2
        versionName = "0.2.0"
    }

    signingConfigs {
        if (hasReleaseKeystore) {
            create("release") {
                storeFile = file(keystoreProperties.getProperty("storeFile"))
                storePassword = keystoreProperties.getProperty("storePassword")
                keyAlias = keystoreProperties.getProperty("keyAlias")
                keyPassword = keystoreProperties.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            // Use the release keystore when android/keystore.properties is
            // present (the release rig); otherwise fall back to the debug
            // signing config (the AGP default, backed by the SDK's own
            // ~/.android/debug.keystore) so the build never fails on a
            // machine that doesn't hold the release key.
            signingConfig = if (hasReleaseKeystore) {
                signingConfigs.getByName("release")
            } else {
                signingConfigs.getByName("debug")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

// Bundle the BUILT web console into APK assets. MainActivity serves these as
// the console origin (see web/BundledConsole.kt), so the network stops being
// load-bearing for the UI. The console must be built first
// (`cd app && npm run build` at the repo root — note: repo-root `app/`, not
// this module's own `android/app/`); staging into build/ keeps the copies out
// of git, same as charter/android/carrier/build.gradle.kts's own pattern.
val consoleDist = rootProject.file("../app/dist")

// Separate task, not a doFirst on the Copy: a Copy whose source dir is absent
// is skipped as NO-SOURCE and never runs its actions — the failure must not
// be skippable, or an empty dist ships a blank console silently.
val checkConsoleDist by tasks.registering {
    doLast {
        if (!consoleDist.resolve("index.html").exists()) {
            throw GradleException(
                "app/dist/index.html is missing — build the web console first: " +
                    "(cd app && npm run build)",
            )
        }
    }
}
val stageConsoleAssets by tasks.registering(Copy::class) {
    description = "Stage app/dist into APK assets as the bundled console."
    dependsOn(checkConsoleDist)
    from(consoleDist)
    into(layout.buildDirectory.dir("generated/webAssets/console"))
}
android.sourceSets.getByName("main").assets.srcDir(layout.buildDirectory.dir("generated/webAssets"))
tasks.named("preBuild") { dependsOn(stageConsoleAssets) }

dependencies {
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-ktx:1.9.3")
}
