package com.mikerosoft.threadbear.android.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.mikerosoft.threadbear.android.LocalModel
import com.mikerosoft.threadbear.kit.CommandKey
import com.mikerosoft.threadbear.kit.PendingCommand
import com.mikerosoft.threadbear.kit.PhoneThread
import com.mikerosoft.threadbear.kit.ShareSheet
import kotlinx.coroutines.delay

/**
 * Sharing a thread by link (backend API 8), from its menu: the website's
 * Share panel (web/src/share.tsx, ShareControl) as a bottom sheet. The
 * switch, Copy, Send and New link each show at once (the kit's ShareSheet
 * puts the tap on top of the row) and take no more taps until the runner's
 * done it; a refusal puts it back and says why.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ShareThreadSheet(thread: PhoneThread, close: () -> Unit) {
    val model = LocalModel.current
    val context = LocalContext.current
    val colors = MaterialTheme.colorScheme
    val signals = LocalSignals.current
    val pending by model.commands.entries.collectAsStateWithLifecycle()
    val site by model.site.collectAsStateWithLifecycle()
    val key = CommandKey.Share(thread.threadId)
    val entry = pending[key]
    val state = entry?.state ?: PendingCommand.Idle
    val view = ShareSheet.view(thread.share, site, state, entry?.value, model.offlineRunner(thread))
    // The row shows what was asked: let the command go, so the controls take taps again.
    LaunchedEffect(view.settled) { if (view.settled) model.commands.forget(key) }
    var copied by remember { mutableStateOf(false) }
    LaunchedEffect(copied) { if (copied) { delay(1500); copied = false } }

    ModalBottomSheet(onDismissRequest = close, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = colors.surfaceContainerLow) {
        Column(Modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, bottom = 28.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Share with a link", style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                if (view.switching) {
                    CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = colors.onSurfaceVariant)
                    Spacer(Modifier.width(12.dp))
                }
                Switch(
                    checked = view.on,
                    onCheckedChange = { model.share(thread.threadId, view.toggle) },
                    enabled = !view.locked,
                    modifier = Modifier.semantics { contentDescription = "Share with a link" },
                )
            }
            Text(view.says, style = MaterialTheme.typography.bodyMedium, color = colors.onSurfaceVariant)
            val link = view.link
            if (link != null) {
                SelectionContainer {
                    Text(
                        link,
                        style = MaterialTheme.typography.bodyMedium,
                        color = if (view.canSend) colors.onSurface else colors.onSurfaceVariant,
                        modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(colors.surfaceContainerHighest)
                            .heightIn(min = 44.dp).padding(horizontal = 12.dp, vertical = 12.dp),
                    )
                }
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Pill(
                        if (copied) "Copied" else "Copy",
                        {
                            (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("Thread link", link))
                            copied = true
                        },
                        Modifier.weight(1f), filled = true, enabled = view.canSend, icon = if (copied) Line.Check else Line.Copy,
                    )
                    Pill(
                        "Send",
                        {
                            val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, link)
                                .putExtra(Intent.EXTRA_SUBJECT, model.title(thread, pending))
                            context.startActivity(Intent.createChooser(send, "Send the link").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                        },
                        Modifier.weight(1f), enabled = view.canSend, icon = Line.Share,
                    )
                }
            } else if (view.making) {
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.heightIn(min = 44.dp)) {
                    CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 1.5.dp, color = colors.onSurfaceVariant)
                    Spacer(Modifier.width(10.dp))
                    Text(if (view.renewing) "Making a new link" else "Making the link", style = MaterialTheme.typography.bodyMedium, color = colors.onSurfaceVariant)
                }
            }
            val newLink = view.newLink
            if (newLink != null || view.renewing) {
                Pill(
                    "New link",
                    { newLink?.let { model.share(thread.threadId, it) } },
                    Modifier.fillMaxWidth(), spinning = view.renewing, enabled = !view.locked && newLink != null,
                    note = "The old link stops working",
                )
            }
            view.note?.let {
                Text(it, style = MaterialTheme.typography.bodySmall, color = if (state is PendingCommand.Failed) signals.failed else colors.onSurfaceVariant)
            }
        }
    }
}
