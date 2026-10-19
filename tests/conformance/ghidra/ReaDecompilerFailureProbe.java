//@category REA Verification

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import generic.jar.ResourceFile;
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileProcess.DisposeState;
import ghidra.app.decompiler.DecompileResults;
import ghidra.app.script.GhidraScript;
import ghidra.app.script.GhidraScriptUtil;
import ghidra.framework.Application;
import ghidra.program.model.listing.Function;
import ghidra.util.task.TaskMonitor;
import java.io.File;
import java.lang.reflect.Field;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.List;

/**
 * Replaces the bridge decompiler after real import and analysis so one procedure's
 * decompilation fails. Verifies that analyze_function still returns the listing-backed
 * facts. This injection does not establish which natural inputs make Ghidra fail.
 */
public class ReaDecompilerFailureProbe extends GhidraScript {
    private static final String INJECTED = "Injected backend failure";
    private static final List<String> LISTING_FACETS = List.of(
        "assembly", "comments", "callers", "callees", "incoming_references",
        "outgoing_references", "referenced_strings", "referenced_names", "basic_blocks",
        "unresolved_calls");
    private final JsonArray checks = new JsonArray();

    private void require(String name, boolean condition) {
        if (!condition) throw new IllegalStateException("Decompiler failure assertion failed: " + name);
        checks.add(name);
    }

    private Function function(String name) {
        for (Function f : currentProgram.getFunctionManager().getFunctions(true))
            if (!f.isThunk() && (f.getName().equals(name) || f.getName().equals("_" + name))) return f;
        throw new IllegalStateException("Missing fixture function " + name);
    }

    private GhidraScript script(String name, File expected) throws Exception {
        ResourceFile source = GhidraScriptUtil.findScriptByName(name);
        if (source == null || !expected.equals(new File(source.getAbsolutePath()).getCanonicalFile()))
            throw new IllegalStateException("Fixture resolved an unexpected script: " + name);
        GhidraScript instance = GhidraScriptUtil.getProvider(source).getScriptInstance(source, errorWriter);
        instance.set(getState(), getControls());
        return instance;
    }

    private static DecompInterface failing(Function expected, DisposeState disposition) {
        return new DecompInterface() {
            @Override
            public DecompileResults decompileFunction(Function function, int timeout, TaskMonitor taskMonitor) {
                if (!function.equals(expected))
                    throw new IllegalStateException("Unexpected decompilation of " + function.getName());
                return new DecompileResults(function, function.getProgram().getLanguage(),
                    function.getProgram().getCompilerSpec(), null, INJECTED, null, disposition);
            }
        };
    }

    private static String failureCode(Throwable failure) throws Exception {
        Field code = failure.getClass().getDeclaredField("code");
        code.setAccessible(true);
        return (String) code.get(failure);
    }

    private static Object accessor(Object record, String name) throws Exception {
        Method method = record.getClass().getDeclaredMethod(name);
        method.setAccessible(true);
        return method.invoke(record);
    }

    /** Same envelope the bridge returns for the analyze_function request. */
    private static JsonObject envelope(Object observation) throws Exception {
        JsonObject result = new JsonObject();
        result.add("value", (JsonObject) accessor(observation, "dossier"));
        JsonArray limitations = new JsonArray();
        for (Object item : (List<?>) accessor(observation, "limitations")) limitations.add(item.toString());
        result.add("limitations", limitations);
        result.add("relationship_coverage", (JsonObject) accessor(observation, "relationshipCoverage"));
        return result;
    }

    private static String reason(JsonObject value) {
        JsonElement reason = value.get("reason");
        return reason == null ? null : reason.getAsString();
    }

    @Override
    public void run() throws Exception {
        String[] args = getScriptArgs();
        if (args.length != 1) throw new IllegalArgumentException("Expected exact bridge directory");
        File directory = new File(args[0]).getCanonicalFile();
        GhidraScript bridge = script("ReaGhidraBridge.java", new File(directory, "ReaGhidraBridge.java"));
        Field space = bridge.getClass().getDeclaredField("sessionDefaultAddressSpace");
        space.setAccessible(true);
        space.set(null, currentProgram.getAddressFactory().getDefaultAddressSpace());
        Method initialize = bridge.getClass().getDeclaredMethod("initializeDecompiler");
        initialize.setAccessible(true);
        initialize.invoke(bridge);
        Method analyze = bridge.getClass().getDeclaredMethod("analyzeFunctionObservation", JsonObject.class);
        analyze.setAccessible(true);
        Method pseudocode = bridge.getClass().getDeclaredMethod("procedurePseudocode", JsonObject.class);
        pseudocode.setAccessible(true);
        Field decompiler = bridge.getClass().getDeclaredField("decompiler");
        decompiler.setAccessible(true);
        DecompInterface real = (DecompInterface) decompiler.get(bridge);

        Function target = function("rea_cross_branch");
        JsonObject query = new JsonObject();
        query.addProperty("procedure", target.getName());
        JsonObject pseudocodeQuery = new JsonObject();
        pseudocodeQuery.add("document", JsonNull.INSTANCE);
        pseudocodeQuery.addProperty("procedure", target.getName());

        JsonObject baseline;
        JsonObject degraded;
        try {
            Object healthy = analyze.invoke(bridge, query);
            baseline = envelope(healthy);
            JsonObject value = baseline.getAsJsonObject("value");
            require("baseline_pseudocode_available", !value.get("pseudocode").getAsString().isEmpty() &&
                value.getAsJsonObject("facet_availability").getAsJsonObject("pseudocode").get("available").getAsBoolean());
            require("baseline_native_api_available", value.getAsJsonObject("native_api").get("available").getAsBoolean());
            require("baseline_listing_facts_present", value.getAsJsonArray("assembly").size() > 0 &&
                value.getAsJsonArray("callers").size() > 0 && value.getAsJsonArray("callees").size() > 0 &&
                value.getAsJsonArray("basic_blocks").size() > 1);

            decompiler.set(bridge, failing(target, DisposeState.NOT_DISPOSED));
            degraded = envelope(analyze.invoke(bridge, query));
            JsonObject dossier = degraded.getAsJsonObject("value");
            String expected = "Ghidra decompilation failed: " + INJECTED;
            require("dossier_returned", dossier.getAsJsonObject("procedure").get("address").getAsString()
                .equals(value.getAsJsonObject("procedure").get("address").getAsString()));
            JsonObject facets = dossier.getAsJsonObject("facet_availability");
            require("pseudocode_unavailable_with_failure", dossier.get("pseudocode").getAsString().isEmpty() &&
                !facets.getAsJsonObject("pseudocode").get("available").getAsBoolean() &&
                expected.equals(reason(facets.getAsJsonObject("pseudocode"))));
            require("native_api_unavailable_with_failure",
                !dossier.getAsJsonObject("native_api").get("available").getAsBoolean() &&
                expected.equals(reason(dossier.getAsJsonObject("native_api"))));
            require("native_value_flow_unavailable_with_failure",
                !dossier.getAsJsonObject("native_value_flow").get("available").getAsBoolean() &&
                expected.equals(reason(dossier.getAsJsonObject("native_value_flow"))));
            for (String facet : LISTING_FACETS)
                require("listing_facet_unchanged_" + facet, dossier.get(facet).equals(value.get(facet)));
            for (String facet : List.of("assembly", "comments", "callers", "callees", "references", "strings_names", "cfg"))
                require("facet_availability_unchanged_" + facet,
                    facets.get(facet).equals(value.getAsJsonObject("facet_availability").get(facet)));
            require("relationship_coverage_unchanged",
                degraded.get("relationship_coverage").equals(baseline.get("relationship_coverage")));
            boolean named = false;
            for (JsonElement item : dossier.getAsJsonArray("limitations"))
                named |= item.getAsString().startsWith(expected + ". Pseudocode, the native API boundary") &&
                    item.getAsString().contains("were still collected");
            require("failure_limitation_named", named);

            try {
                pseudocode.invoke(bridge, pseudocodeQuery);
                throw new IllegalStateException("Pseudocode request unexpectedly succeeded");
            } catch (InvocationTargetException failure) {
                require("pseudocode_request_still_fails",
                    failureCode(failure.getCause()).equals("decompile_failed") &&
                    failure.getCause().getMessage().equals(expected));
            }

            decompiler.set(bridge, failing(target, DisposeState.DISPOSED_ON_CANCEL));
            try {
                analyze.invoke(bridge, query);
                throw new IllegalStateException("Cancelled decompilation unexpectedly returned a dossier");
            } catch (InvocationTargetException failure) {
                require("cancellation_still_ends_request",
                    failureCode(failure.getCause()).equals("decompile_cancelled"));
            }

            decompiler.set(bridge, real);
            Object recovered = analyze.invoke(bridge, query);
            require("session_recovers_after_failure", envelope(recovered).getAsJsonObject("value")
                .getAsJsonObject("facet_availability").getAsJsonObject("pseudocode").get("available").getAsBoolean());
        } finally {
            decompiler.set(bridge, real);
            real.dispose();
        }

        JsonObject report = new JsonObject();
        report.addProperty("status", "passed");
        report.addProperty("ghidra_version", Application.getApplicationVersion());
        report.addProperty("target_sha256", currentProgram.getExecutableSHA256());
        byte[] bytes = Files.readAllBytes(new File(directory, "ReaGhidraBridge.java").toPath());
        report.addProperty("ReaGhidraBridge.java",
            HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)));
        report.add("checks", checks);
        report.add("baseline", baseline);
        report.add("degraded", degraded);
        println("REA_DECOMPILER_FAILURE_PROBE_JSON " + report);
    }
}
