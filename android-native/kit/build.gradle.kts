plugins {
    id("org.jetbrains.kotlin.jvm")
}

// Java 17 bytecode from whatever JDK runs Gradle (17 or later), rather than a
// toolchain that needs a JDK 17 itself: F-Droid's build image only has 21.
java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}
kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) } }

dependencies {
    api("org.jetbrains.kotlinx:kotlinx-serialization-json:1.6.3")
    api("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.10.2")
    testImplementation(kotlin("test"))
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.10.2")
}

// The kit's tests also run the cases every app shares (shared/cases), read from
// the repo's top: an input, so a changed case file runs them again.
tasks.test {
    useJUnitPlatform()
    inputs.dir(rootDir.resolve("../shared/cases"))
}
