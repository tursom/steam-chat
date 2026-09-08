package io.github.steamchat.android

import android.app.Application

class ChatApplication : Application() {
    lateinit var repository: ChatRepository
        private set
    override fun onCreate() {
        super.onCreate()
        ChatNotifications.channels(this)
        repository = ChatRepository(this)
    }
}
