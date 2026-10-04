package io.github.steamchat.android

import android.annotation.SuppressLint
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.PowerManager
import android.provider.Settings
import androidx.core.net.toUri
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import java.util.concurrent.TimeUnit

/** Restores the foreground service after reboot or an APK update; both broadcasts may start a foreground service. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action !in listOf(Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_MY_PACKAGE_REPLACED)) return
        (context.applicationContext as? ChatApplication)?.repository?.onSystemStart()
    }
}

/** Periodic fallback when the service or socket was reclaimed: revive them and run one bounded REST catch-up. */
class WatchdogWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        (applicationContext as? ChatApplication)?.repository?.backgroundCheck()
        return Result.success()
    }
}

internal object BackgroundWork {
    private const val WATCHDOG = "background-watchdog"

    // WorkManager may be uninitialized in host tests; scheduling is best-effort like the service start.
    fun schedule(context: Context) = runCatching {
        val request = PeriodicWorkRequestBuilder<WatchdogWorker>(15, TimeUnit.MINUTES)
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()).build()
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(WATCHDOG, ExistingPeriodicWorkPolicy.KEEP, request)
    }
    fun cancel(context: Context) = runCatching { WorkManager.getInstance(context).cancelUniqueWork(WATCHDOG) }

    fun batteryExempt(context: Context): Boolean =
        context.getSystemService(PowerManager::class.java)?.isIgnoringBatteryOptimizations(context.packageName) == true

    // Sideloaded personal client: the one-tap exemption dialog is the intended UX, not a Play-policy concern.
    @SuppressLint("BatteryLife")
    fun exemptionRequest(context: Context): Intent =
        Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, "package:${context.packageName}".toUri())
    fun batterySettings(): Intent = Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
    fun appDetails(context: Context): Intent =
        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, "package:${context.packageName}".toUri())
}
