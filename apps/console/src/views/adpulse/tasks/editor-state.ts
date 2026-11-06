export interface TaskEditorState<Form> {
	form: Form;
	version: number | null;
	dirty: boolean;
	remoteVersion: number | null;
}

export type TaskEditorAction<Form> =
	| { type: "remote"; version: number; form: Form }
	| { type: "edit"; form: Form }
	| {
			type: "saved";
			version: number;
			form: Form;
			submittedForm: Form;
	  };

export function reduceTaskEditorState<Form>(
	state: TaskEditorState<Form>,
	action: TaskEditorAction<Form>,
): TaskEditorState<Form> {
	if (action.type === "remote") {
		if (state.version !== null && action.version <= state.version) return state;
		if (state.dirty)
			return {
				...state,
				version: state.version ?? action.version,
				remoteVersion: action.version,
			};
		return {
			form: action.form,
			version: action.version,
			dirty: false,
			remoteVersion: null,
		};
	}

	if (action.type === "edit") return { ...state, form: action.form, dirty: true };

	const unchanged = JSON.stringify(state.form) === JSON.stringify(action.submittedForm);
	return {
		form: unchanged ? action.form : state.form,
		version: action.version,
		dirty: !unchanged,
		remoteVersion: null,
	};
}

export function reuseOperation<Operation>(
	current: Operation | null,
	create: () => Operation,
): Operation {
	return current ?? create();
}
