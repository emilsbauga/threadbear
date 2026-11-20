package com.mikerosoft.threadbear.android.ui

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.platform.LocalContext
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning

/**
 * The pairing scanner, the github build's: Google's code scanner (ML Kit,
 * through Play services), which needs no camera permission of the app's own.
 * Calling what this gives opens it.
 */
@Composable
fun rememberQrScanner(failed: (String) -> Unit, found: (String) -> Unit): () -> Unit {
    val context = LocalContext.current
    val onFound by rememberUpdatedState(found)
    val onFailed by rememberUpdatedState(failed)
    return remember(context) { { scan(context, { onFailed(it) }) { onFound(it) } } }
}

private fun scan(context: Context, failed: (String) -> Unit, found: (String) -> Unit) {
    val options = GmsBarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build()
    GmsBarcodeScanning.getClient(context, options).startScan()
        .addOnSuccessListener { code -> code.rawValue?.let(found) }
        .addOnFailureListener { failed("Couldn't open the scanner: ${it.message}") }
}
