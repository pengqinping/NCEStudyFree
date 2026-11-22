// NCE StudyFree 原生 TTS：封装系统 TextToSpeech。
// 命令与 Rust 侧约定一致：voices / speak / stop；
// 状态经事件 nce-tts://state 回报 { phase: start | end | error, message? }。
//
// 说明：本文件为骨架实现，首次 `cargo tauri android init` 后，
// 需按生成的 gradle 结构把本包并入 settings.gradle 并对齐 Plugin 基类导入。

package com.cencyzp.ncestudyfree.tts

import android.app.Activity
import android.content.Context
import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.webkit.JavascriptInterface
import app.tauri.Logger
import app.tauri.Plugin
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.ipc.Invoke

@InvokeArg
class SpeakArgs {
    lateinit var text: String
    var rate: Double = 1.0
    var voiceName: String = ""
}

@TauriPlugin
class TtsPlugin(private val activity: Activity) : Plugin(activity) {
    private var tts: TextToSpeech? = null
    private val ready = java.util.concurrent.atomic.AtomicBoolean(false)
    private var generation: Double = 0.0

    override fun load(webview: android.webkit.WebView) {
        super.load(webview)
        tts = TextToSpeech(activity.applicationContext) { status ->
            if (status == TextToSpeech.SUCCESS) {
                ready.set(true)
                Logger.info("TtsPlugin", "系统 TTS 就绪")
            } else {
                emitState("error", "系统 TTS 初始化失败（status=$status）")
            }
        }
        tts?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(utteranceId: String?) {
                emitState("start", null)
            }

            override fun onDone(utteranceId: String?) {
                emitState("end", null)
            }

            @Deprecated("Deprecated in Java")
            override fun onError(utteranceId: String?) {
                emitState("error", "朗读失败")
            }

            override fun onError(utteranceId: String?, errorCode: Int) {
                emitState("error", "朗读失败（errorCode=$errorCode）")
            }
        })
    }

    private fun emitState(phase: String, message: String?) {
        val data = app.tauri.JSObject().apply {
            put("phase", phase)
            message?.let { put("message", it) }
            put("generation", generation)
        }
        trigger("nce-tts://state", data)
    }

    @Command
    fun voices(invoke: Invoke) {
        val list = mutableListOf<app.tauri.JSObject>()
        if (ready.get()) {
            tts?.voices?.forEach { voice ->
                val item = app.tauri.JSObject()
                item.put("name", voice.name)
                item.put("lang", voice.locale.toString())
                list.add(item)
            }
        }
        invoke.resolve(list)
    }

    @Command
    fun speak(invoke: Invoke) {
        val args = invoke.parseArgs(SpeakArgs::class.java)
        if (!ready.get()) {
            invoke.reject("系统 TTS 尚未就绪")
            return
        }
        generation += 1
        if (args.voiceName.isNotBlank()) {
            tts?.voices?.find { it.name == args.voiceName }?.let { tts?.voice = it }
        }
        tts?.setSpeechRate(args.rate.toFloat())
        val utteranceId = "nce-tts-$generation"
        val params = Bundle().apply { putString(TextToSpeech.Engine.KEY_PARAM_UTTERANCE_ID, utteranceId) }
        tts?.speak(args.text, TextToSpeech.QUEUE_FLUSH, params, utteranceId)
        invoke.resolve()
    }

    @Command
    fun stop(invoke: Invoke) {
        generation += 1
        tts?.stop()
        invoke.resolve()
    }

    override fun onDestroy() {
        tts?.stop()
        tts?.shutdown()
        tts = null
        super.onDestroy()
    }
}
