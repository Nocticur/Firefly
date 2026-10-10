import { useCallback, useEffect, useState } from "react";
import { request, message } from "./api";
export function useData<T>(path: string) {
	const [data, setData] = useState<T | null>(null);
	const [revision, setRevision] = useState<number | undefined>();
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
	const reload = useCallback(async () => {
		setLoading(true); setError("");
		try { const result = await request<T>(path); setData(result.data); setRevision(result.revision); }
		catch (error) { setError(message(error)); }
		finally { setLoading(false); }
	}, [path]);
	useEffect(() => { void reload(); }, [reload]);
	return { data, setData, revision, loading, error, reload };
}
