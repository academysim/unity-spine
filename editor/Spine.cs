// Spine.cs - the editor half of the automation spine.
// Every method here writes a JSON marker file before exiting. The outside driver treats
// "exited 0 but wrote no marker" as a failure, because Unity can exit cleanly after a
// script threw and the exit code alone will not tell you.
using System;
using System.IO;
using System.Linq;
using System.Text;
using UnityEditor;
using UnityEditor.Build.Reporting;
using UnityEngine;

public static class Spine
{
    // ---------- helpers ----------
    static string Esc(string s) =>
        (s ?? "").Replace("\\", "/").Replace("\"", "'").Replace("\r", "").Replace("\n", " | ");

    static void WriteMarker(string file, string json)
    {
        try { File.WriteAllText(file, json); }
        catch (Exception e) { Console.WriteLine("SPINE marker write failed: " + e.Message); }
        Console.WriteLine("SPINE " + file + " " + json.Replace("\n", " "));
    }

    static string Arg(string name, string fallback)
    {
        var args = Environment.GetCommandLineArgs();
        for (int i = 0; i < args.Length - 1; i++)
            if (args[i] == name) return args[i + 1];
        return fallback;
    }

    // ---------- compile check ----------
    // Reaching this method at all proves every script in the project compiled.
    public static void Ping()
    {
        var sb = new StringBuilder();
        sb.Append("{\n  \"ok\": true");
        sb.Append(",\n  \"unity\": \"").Append(Application.unityVersion).Append('"');
        sb.Append(",\n  \"target\": \"").Append(EditorUserBuildSettings.activeBuildTarget).Append('"');
        sb.Append(",\n  \"scenesInBuild\": ").Append(EditorBuildSettings.scenes.Length);
        sb.Append(",\n  \"assets\": ").Append(AssetDatabase.FindAssets("").Length);
        sb.Append("\n}");
        WriteMarker("spine-ping.json", sb.ToString());
        EditorApplication.Exit(0);
    }

    // ---------- builds ----------
    static string[] ScenesInBuild()
    {
        var s = EditorBuildSettings.scenes.Where(x => x.enabled).Select(x => x.path).ToArray();
        if (s.Length > 0) return s;
        // fall back to every scene in the project so a fresh project can still build
        return AssetDatabase.FindAssets("t:Scene")
            .Select(AssetDatabase.GUIDToAssetPath)
            .Where(p => p.StartsWith("Assets/"))
            .ToArray();
    }

    public static void BuildWindows() => Build(BuildTarget.StandaloneWindows64,
        Arg("-buildOutput", "Build/Windows/Game.exe"));

    public static void BuildWebGL() => Build(BuildTarget.WebGL,
        Arg("-buildOutput", "Build/WebGL"));

    static void Build(BuildTarget target, string output)
    {
        var scenes = ScenesInBuild();
        if (scenes.Length == 0)
        {
            WriteMarker("spine-build.json",
                "{\n  \"result\": \"NoScenes\",\n  \"error\": \"project has no scenes to build\"\n}");
            EditorApplication.Exit(1);
            return;
        }

        // The driver passes -buildTarget on the command line, so the editor already booted
        // on the right target. Switching it here would trigger a recompile and domain
        // reload mid-method, which Unity documents as unreliable. Fail loudly instead.
        if (EditorUserBuildSettings.activeBuildTarget != target)
        {
            WriteMarker("spine-build.json",
                "{ \"result\": \"WrongTarget\", \"error\": \"editor booted on " +
                EditorUserBuildSettings.activeBuildTarget + " but " + target +
                " was requested - pass -buildTarget on the command line\" }");
            EditorApplication.Exit(1);
            return;
        }

        if (target == BuildTarget.WebGL)
        {
            // plain static hosting cannot serve brotli without custom headers
            PlayerSettings.WebGL.compressionFormat = WebGLCompressionFormat.Disabled;
            PlayerSettings.WebGL.decompressionFallback = true;
        }

        BuildReport report;
        try
        {
            report = BuildPipeline.BuildPlayer(new BuildPlayerOptions
            {
                scenes = scenes,
                locationPathName = output,
                target = target,
                options = BuildOptions.None,
            });
        }
        catch (Exception e)
        {
            WriteMarker("spine-build.json",
                "{\n  \"result\": \"Exception\",\n  \"error\": \"" + Esc(e.Message) + "\"\n}");
            EditorApplication.Exit(1);
            return;
        }

        var s = report.summary;
        var sb = new StringBuilder();
        sb.Append("{\n  \"result\": \"").Append(s.result).Append('"');
        sb.Append(",\n  \"target\": \"").Append(target).Append('"');
        sb.Append(",\n  \"sizeBytes\": ").Append(s.totalSize);
        sb.Append(",\n  \"seconds\": ").Append(s.totalTime.TotalSeconds.ToString("F1"));
        sb.Append(",\n  \"errors\": ").Append(s.totalErrors);
        sb.Append(",\n  \"warnings\": ").Append(s.totalWarnings);
        sb.Append(",\n  \"scenes\": ").Append(scenes.Length);
        sb.Append(",\n  \"output\": \"").Append(Esc(s.outputPath)).Append('"');
        sb.Append("\n}");
        WriteMarker("spine-build.json", sb.ToString());

        EditorApplication.Exit(s.result == BuildResult.Succeeded ? 0 : 1);
    }

    // ---------- scene authoring, callable by name from the CLI ----------
    // Proves an agent can build scene content with no editor window. Extend freely.
    public static void NewEmptyScene()
    {
        var dir = "Assets/Scenes";
        if (!Directory.Exists(dir)) Directory.CreateDirectory(dir);
        var name = Arg("-sceneName", "Main");
        var scenePath = dir + "/" + name + ".unity";

        var scene = UnityEditor.SceneManagement.EditorSceneManager
            .NewScene(UnityEditor.SceneManagement.NewSceneSetup.EmptyScene,
                      UnityEditor.SceneManagement.NewSceneMode.Single);

        var camGo = new GameObject("Main Camera");
        camGo.tag = "MainCamera";
        var cam = camGo.AddComponent<Camera>();
        cam.transform.position = new Vector3(0f, 3f, -8f);
        cam.clearFlags = CameraClearFlags.SolidColor;
        cam.backgroundColor = new Color(0.06f, 0.08f, 0.11f);

        var lightGo = new GameObject("Key Light");
        var light = lightGo.AddComponent<Light>();
        light.type = LightType.Directional;
        lightGo.transform.rotation = Quaternion.Euler(48f, -30f, 0f);

        UnityEditor.SceneManagement.EditorSceneManager.SaveScene(scene, scenePath);
        EditorBuildSettings.scenes = new[] { new EditorBuildSettingsScene(scenePath, true) };
        AssetDatabase.SaveAssets();
        AssetDatabase.Refresh();

        WriteMarker("spine-scene.json",
            "{\n  \"scene\": \"" + Esc(scenePath) + "\",\n  \"exists\": " +
            (File.Exists(scenePath) ? "true" : "false") + "\n}");
        EditorApplication.Exit(0);
    }
}
