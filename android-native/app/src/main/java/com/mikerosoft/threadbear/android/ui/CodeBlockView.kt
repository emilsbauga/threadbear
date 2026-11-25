package com.mikerosoft.threadbear.android.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.DisableSelection
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mikerosoft.threadbear.kit.CodeColours
import com.mikerosoft.threadbear.kit.CodeStyle
import com.mikerosoft.threadbear.kit.MarkdownBlock
import kotlinx.coroutines.delay

/**
 * A fenced code block: a slim header strip (the language on the left, a
 * copy button on the right, a hairline under it) over the code, which
 * scrolls sideways. The same "header bar" design as the Mac's. A block
 * with no language still gets the strip, with just the copy button.
 */
@Composable
fun CodeBlockView(block: MarkdownBlock.Code, style: TextStyle) {
    val colors = MaterialTheme.colorScheme
    val signals = LocalSignals.current
    val context = LocalContext.current
    val haptics = LocalHapticFeedback.current
    // Which tap the "Copied" belongs to, so an older tap's timer doesn't put the icon back early.
    var copies by remember { mutableIntStateOf(0) }
    var copiedFor by remember { mutableIntStateOf(-1) }
    val copied = copiedFor == copies && copies > 0
    val dark = isSystemInDarkTheme()
    // Worked out once per block and theme, not on every recomposition.
    val coloured = remember(block.text, block.language, dark) { colouredCode(block.text, block.language, dark) }
    LaunchedEffect(copies) {
        if (copies == 0) return@LaunchedEffect
        delay(1500)
        copiedFor = -1
    }
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).background(colors.surfaceContainerHigh)) {
        DisableSelection {
            Row(
                Modifier.fillMaxWidth().height(30.dp).background(colors.surfaceContainerHighest).padding(start = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                val name = block.languageName
                if (name != null) {
                    Text(
                        name, style = MaterialTheme.typography.labelMedium, color = colors.onSurfaceVariant,
                        maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false),
                    )
                }
                Spacer(Modifier.weight(1f))
                Row(
                    Modifier.fillMaxHeight().clickable(onClickLabel = "Copy code") {
                        val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                        clipboard.setPrimaryClip(ClipData.newPlainText(name ?: "Code", block.text))
                        haptics.performHapticFeedback(HapticFeedbackType.Confirm)
                        copies += 1
                        copiedFor = copies
                    }.padding(horizontal = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    if (copied) {
                        Icon(Line.Check, null, Modifier.size(14.dp), tint = signals.done)
                        Spacer(Modifier.width(5.dp))
                        Text("Copied", style = MaterialTheme.typography.labelMedium, color = signals.done, fontWeight = FontWeight.SemiBold)
                    } else {
                        Icon(Line.Copy, "Copy code", Modifier.size(15.dp), tint = colors.onSurfaceVariant)
                    }
                }
            }
        }
        HorizontalDivider(color = colors.outlineVariant)
        Box(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(10.dp)) {
            Text(coloured, style = style.copy(fontFamily = Mono, fontSize = 13.sp, lineHeight = 18.sp))
        }
    }
}

/**
 * The block's code with its colours (CodeColours in the kit), in the Mac's
 * highlight theme (gpui-component's default-theme.json, "Default Dark" and
 * "Default Light"). Unknown languages and huge blocks come back plain.
 */
internal fun colouredCode(code: String, language: String?, dark: Boolean): AnnotatedString {
    val spans = CodeColours.spans(code, language)
    if (spans.isEmpty()) return AnnotatedString(code)
    val palette = if (dark) DarkCode else LightCode
    return buildAnnotatedString {
        append(code)
        for (span in spans) addStyle(palette.getValue(span.style), span.start, span.end)
    }
}

private fun c(hex: Long) = SpanStyle(color = Color(0xFF000000 or hex))

private val DarkCode: Map<CodeStyle, SpanStyle> = mapOf(
    CodeStyle.Keyword to c(0x87B1F6), CodeStyle.Str to c(0xA3E09F), CodeStyle.Escape to c(0x68DC7C),
    CodeStyle.Number to c(0xCC9E00), CodeStyle.Constant to c(0xCC9E00), CodeStyle.Comment to c(0x9D9D9D),
    CodeStyle.Function to c(0xB3C5F3), CodeStyle.Type to c(0xCBA6F7), CodeStyle.Property to c(0xBCC4E0),
    CodeStyle.Tag to c(0x419CFF), CodeStyle.Attribute to c(0x7FAEF9),
    CodeStyle.Heading to SpanStyle(color = Color(0xFFCC9E00), fontWeight = FontWeight.SemiBold),
    CodeStyle.Literal to c(0xA3E09F), CodeStyle.Special to c(0x419CFF),
    // The Mac's theme has no diff colours; the app's own green and red.
    CodeStyle.Inserted to c(0x30D158), CodeStyle.Deleted to c(0xFF453A),
)

private val LightCode: Map<CodeStyle, SpanStyle> = mapOf(
    CodeStyle.Keyword to c(0x0433FF), CodeStyle.Str to c(0x036A07), CodeStyle.Escape to c(0x036A07),
    CodeStyle.Number to c(0x0433FF), CodeStyle.Constant to c(0xC5060B), CodeStyle.Comment to c(0x007FFF),
    CodeStyle.Function to c(0x0000A2), CodeStyle.Type to c(0x6F42C1), CodeStyle.Property to c(0x333333),
    CodeStyle.Tag to c(0x0433FF), CodeStyle.Attribute to c(0x957931),
    CodeStyle.Heading to c(0x0433FF), CodeStyle.Literal to c(0x6F42C1), CodeStyle.Special to c(0xC5060B),
    CodeStyle.Inserted to c(0x28A745), CodeStyle.Deleted to c(0xFF3B30),
)
