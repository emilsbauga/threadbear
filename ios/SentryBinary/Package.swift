// swift-tools-version: 6.0
// Sentry's static framework on its own, for the Mac app (app/Package.swift)
// and the iPhone app (ios/Threadbear.xcodeproj). sentry-cocoa's own package
// declares eight prebuilt frameworks and SwiftPM downloads and unpacks every
// one, 3.2 GB in each checkout's .build; this is the one the apps link
// (about 360 MB, every Apple platform). It lives here, beside the iPhone
// app that outlives the frozen Mac app; app/SentryBinary is a link to it.
//
// To update: the URL and checksum are the "Sentry" binary target in
// https://github.com/getsentry/sentry-cocoa/blob/<version>/Package.swift.
import PackageDescription

let package = Package(
    name: "SentryBinary",
    products: [
        .library(name: "Sentry", targets: ["Sentry", "SentryLinkCpp"]),
    ],
    targets: [
        .binaryTarget(
            name: "Sentry",
            url: "https://github.com/getsentry/sentry-cocoa/releases/download/9.31.0/Sentry.xcframework.zip",
            checksum: "86dde13e6145ea3049ee2eb0b07ccb66e137a4d3af0d0dfe0b9d895f80b43237"
        ),
        // The static framework has C++ in it; sentry-cocoa's SentryCppHelper
        // target does the same.
        .target(
            name: "SentryLinkCpp",
            path: "Sources/SentryLinkCpp",
            linkerSettings: [.linkedLibrary("c++")]
        ),
    ]
)
