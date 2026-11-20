package com.mikerosoft.threadbear.android.ui

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions

/**
 * The pairing scanner, the fdroid build's: ZXing's, QR codes only. The
 * camera is asked for at the tap, the first time. Calling what this gives
 * opens it.
 */
@Composable
fun rememberQrScanner(failed: (String) -> Unit, found: (String) -> Unit): () -> Unit {
    val context = LocalContext.current
    val onFound by rememberUpdatedState(found)
    val onFailed by rememberUpdatedState(failed)
    val options = ScanOptions()
        .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
        .setPrompt("Point the camera at the code on your Mac.")
        .setBeepEnabled(false)
        .setOrientationLocked(false)
    // Back without a code (contents null) is just a change of mind.
    val scanner = rememberLauncherForActivityResult(ScanContract()) { result -> result.contents?.let { onFound(it) } }
    val camera = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) scanner.launch(options) else onFailed("Scanning needs the camera. You can paste the code instead.")
    }
    return {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) scanner.launch(options)
        else camera.launch(Manifest.permission.CAMERA)
    }
}
