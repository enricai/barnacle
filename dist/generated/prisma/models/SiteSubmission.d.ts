import type * as runtime from "@prisma/client/runtime/client";
import type * as Prisma from "../internal/prismaNamespace.js";
/**
 * Model SiteSubmission
 * Site-agnostic audit row written by Phase 3 dispatch for every plugin
 * execution. Using one table across all sites lets audit and replay logic live
 * in core rather than being duplicated per-plugin, and makes cross-site queries
 * trivial — the siteId column scopes rows back to the originating plugin.
 */
export type SiteSubmissionModel = runtime.Types.Result.DefaultSelection<Prisma.$SiteSubmissionPayload>;
export type AggregateSiteSubmission = {
    _count: SiteSubmissionCountAggregateOutputType | null;
    _min: SiteSubmissionMinAggregateOutputType | null;
    _max: SiteSubmissionMaxAggregateOutputType | null;
};
export type SiteSubmissionMinAggregateOutputType = {
    id: string | null;
    siteId: string | null;
    status: string | null;
    capturedAt: Date | null;
};
export type SiteSubmissionMaxAggregateOutputType = {
    id: string | null;
    siteId: string | null;
    status: string | null;
    capturedAt: Date | null;
};
export type SiteSubmissionCountAggregateOutputType = {
    id: number;
    siteId: number;
    status: number;
    payload: number;
    capturedAt: number;
    _all: number;
};
export type SiteSubmissionMinAggregateInputType = {
    id?: true;
    siteId?: true;
    status?: true;
    capturedAt?: true;
};
export type SiteSubmissionMaxAggregateInputType = {
    id?: true;
    siteId?: true;
    status?: true;
    capturedAt?: true;
};
export type SiteSubmissionCountAggregateInputType = {
    id?: true;
    siteId?: true;
    status?: true;
    payload?: true;
    capturedAt?: true;
    _all?: true;
};
export type SiteSubmissionAggregateArgs<ExtArgs extends runtime.Types.Extensions.InternalArgs = runtime.Types.Extensions.DefaultArgs> = {
    /**
     * Filter which SiteSubmission to aggregate.
     */
    where?: Prisma.SiteSubmissionWhereInput;
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/sorting Sorting Docs}
     *
     * Determine the order of SiteSubmissions to fetch.
     */
    orderBy?: Prisma.SiteSubmissionOrderByWithRelationInput | Prisma.SiteSubmissionOrderByWithRelationInput[];
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination#cursor-based-pagination Cursor Docs}
     *
     * Sets the start position
     */
    cursor?: Prisma.SiteSubmissionWhereUniqueInput;
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     *
     * Take `±n` SiteSubmissions from the position of the cursor.
     */
    take?: number;
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     *
     * Skip the first `n` SiteSubmissions.
     */
    skip?: number;
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/aggregations Aggregation Docs}
     *
     * Count returned SiteSubmissions
    **/
    _count?: true | SiteSubmissionCountAggregateInputType;
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/aggregations Aggregation Docs}
     *
     * Select which fields to find the minimum value
    **/
    _min?: SiteSubmissionMinAggregateInputType;
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/aggregations Aggregation Docs}
     *
     * Select which fields to find the maximum value
    **/
    _max?: SiteSubmissionMaxAggregateInputType;
};
export type GetSiteSubmissionAggregateType<T extends SiteSubmissionAggregateArgs> = {
    [P in keyof T & keyof AggregateSiteSubmission]: P extends '_count' | 'count' ? T[P] extends true ? number : Prisma.GetScalarType<T[P], AggregateSiteSubmission[P]> : Prisma.GetScalarType<T[P], AggregateSiteSubmission[P]>;
};
export type SiteSubmissionGroupByArgs<ExtArgs extends runtime.Types.Extensions.InternalArgs = runtime.Types.Extensions.DefaultArgs> = {
    where?: Prisma.SiteSubmissionWhereInput;
    orderBy?: Prisma.SiteSubmissionOrderByWithAggregationInput | Prisma.SiteSubmissionOrderByWithAggregationInput[];
    by: Prisma.SiteSubmissionScalarFieldEnum[] | Prisma.SiteSubmissionScalarFieldEnum;
    having?: Prisma.SiteSubmissionScalarWhereWithAggregatesInput;
    take?: number;
    skip?: number;
    _count?: SiteSubmissionCountAggregateInputType | true;
    _min?: SiteSubmissionMinAggregateInputType;
    _max?: SiteSubmissionMaxAggregateInputType;
};
export type SiteSubmissionGroupByOutputType = {
    id: string;
    siteId: string;
    status: string;
    payload: runtime.JsonValue;
    capturedAt: Date;
    _count: SiteSubmissionCountAggregateOutputType | null;
    _min: SiteSubmissionMinAggregateOutputType | null;
    _max: SiteSubmissionMaxAggregateOutputType | null;
};
export type GetSiteSubmissionGroupByPayload<T extends SiteSubmissionGroupByArgs> = Prisma.PrismaPromise<Array<Prisma.PickEnumerable<SiteSubmissionGroupByOutputType, T['by']> & {
    [P in ((keyof T) & (keyof SiteSubmissionGroupByOutputType))]: P extends '_count' ? T[P] extends boolean ? number : Prisma.GetScalarType<T[P], SiteSubmissionGroupByOutputType[P]> : Prisma.GetScalarType<T[P], SiteSubmissionGroupByOutputType[P]>;
}>>;
export type SiteSubmissionWhereInput = {
    AND?: Prisma.SiteSubmissionWhereInput | Prisma.SiteSubmissionWhereInput[];
    OR?: Prisma.SiteSubmissionWhereInput[];
    NOT?: Prisma.SiteSubmissionWhereInput | Prisma.SiteSubmissionWhereInput[];
    id?: Prisma.StringFilter<"SiteSubmission"> | string;
    siteId?: Prisma.StringFilter<"SiteSubmission"> | string;
    status?: Prisma.StringFilter<"SiteSubmission"> | string;
    payload?: Prisma.JsonFilter<"SiteSubmission">;
    capturedAt?: Prisma.DateTimeFilter<"SiteSubmission"> | Date | string;
};
export type SiteSubmissionOrderByWithRelationInput = {
    id?: Prisma.SortOrder;
    siteId?: Prisma.SortOrder;
    status?: Prisma.SortOrder;
    payload?: Prisma.SortOrder;
    capturedAt?: Prisma.SortOrder;
};
export type SiteSubmissionWhereUniqueInput = Prisma.AtLeast<{
    id?: string;
    AND?: Prisma.SiteSubmissionWhereInput | Prisma.SiteSubmissionWhereInput[];
    OR?: Prisma.SiteSubmissionWhereInput[];
    NOT?: Prisma.SiteSubmissionWhereInput | Prisma.SiteSubmissionWhereInput[];
    siteId?: Prisma.StringFilter<"SiteSubmission"> | string;
    status?: Prisma.StringFilter<"SiteSubmission"> | string;
    payload?: Prisma.JsonFilter<"SiteSubmission">;
    capturedAt?: Prisma.DateTimeFilter<"SiteSubmission"> | Date | string;
}, "id">;
export type SiteSubmissionOrderByWithAggregationInput = {
    id?: Prisma.SortOrder;
    siteId?: Prisma.SortOrder;
    status?: Prisma.SortOrder;
    payload?: Prisma.SortOrder;
    capturedAt?: Prisma.SortOrder;
    _count?: Prisma.SiteSubmissionCountOrderByAggregateInput;
    _max?: Prisma.SiteSubmissionMaxOrderByAggregateInput;
    _min?: Prisma.SiteSubmissionMinOrderByAggregateInput;
};
export type SiteSubmissionScalarWhereWithAggregatesInput = {
    AND?: Prisma.SiteSubmissionScalarWhereWithAggregatesInput | Prisma.SiteSubmissionScalarWhereWithAggregatesInput[];
    OR?: Prisma.SiteSubmissionScalarWhereWithAggregatesInput[];
    NOT?: Prisma.SiteSubmissionScalarWhereWithAggregatesInput | Prisma.SiteSubmissionScalarWhereWithAggregatesInput[];
    id?: Prisma.StringWithAggregatesFilter<"SiteSubmission"> | string;
    siteId?: Prisma.StringWithAggregatesFilter<"SiteSubmission"> | string;
    status?: Prisma.StringWithAggregatesFilter<"SiteSubmission"> | string;
    payload?: Prisma.JsonWithAggregatesFilter<"SiteSubmission">;
    capturedAt?: Prisma.DateTimeWithAggregatesFilter<"SiteSubmission"> | Date | string;
};
export type SiteSubmissionCreateInput = {
    id?: string;
    siteId: string;
    status: string;
    payload: Prisma.JsonNullValueInput | runtime.InputJsonValue;
    capturedAt?: Date | string;
};
export type SiteSubmissionUncheckedCreateInput = {
    id?: string;
    siteId: string;
    status: string;
    payload: Prisma.JsonNullValueInput | runtime.InputJsonValue;
    capturedAt?: Date | string;
};
export type SiteSubmissionUpdateInput = {
    id?: Prisma.StringFieldUpdateOperationsInput | string;
    siteId?: Prisma.StringFieldUpdateOperationsInput | string;
    status?: Prisma.StringFieldUpdateOperationsInput | string;
    payload?: Prisma.JsonNullValueInput | runtime.InputJsonValue;
    capturedAt?: Prisma.DateTimeFieldUpdateOperationsInput | Date | string;
};
export type SiteSubmissionUncheckedUpdateInput = {
    id?: Prisma.StringFieldUpdateOperationsInput | string;
    siteId?: Prisma.StringFieldUpdateOperationsInput | string;
    status?: Prisma.StringFieldUpdateOperationsInput | string;
    payload?: Prisma.JsonNullValueInput | runtime.InputJsonValue;
    capturedAt?: Prisma.DateTimeFieldUpdateOperationsInput | Date | string;
};
export type SiteSubmissionCreateManyInput = {
    id?: string;
    siteId: string;
    status: string;
    payload: Prisma.JsonNullValueInput | runtime.InputJsonValue;
    capturedAt?: Date | string;
};
export type SiteSubmissionUpdateManyMutationInput = {
    id?: Prisma.StringFieldUpdateOperationsInput | string;
    siteId?: Prisma.StringFieldUpdateOperationsInput | string;
    status?: Prisma.StringFieldUpdateOperationsInput | string;
    payload?: Prisma.JsonNullValueInput | runtime.InputJsonValue;
    capturedAt?: Prisma.DateTimeFieldUpdateOperationsInput | Date | string;
};
export type SiteSubmissionUncheckedUpdateManyInput = {
    id?: Prisma.StringFieldUpdateOperationsInput | string;
    siteId?: Prisma.StringFieldUpdateOperationsInput | string;
    status?: Prisma.StringFieldUpdateOperationsInput | string;
    payload?: Prisma.JsonNullValueInput | runtime.InputJsonValue;
    capturedAt?: Prisma.DateTimeFieldUpdateOperationsInput | Date | string;
};
export type SiteSubmissionCountOrderByAggregateInput = {
    id?: Prisma.SortOrder;
    siteId?: Prisma.SortOrder;
    status?: Prisma.SortOrder;
    payload?: Prisma.SortOrder;
    capturedAt?: Prisma.SortOrder;
};
export type SiteSubmissionMaxOrderByAggregateInput = {
    id?: Prisma.SortOrder;
    siteId?: Prisma.SortOrder;
    status?: Prisma.SortOrder;
    capturedAt?: Prisma.SortOrder;
};
export type SiteSubmissionMinOrderByAggregateInput = {
    id?: Prisma.SortOrder;
    siteId?: Prisma.SortOrder;
    status?: Prisma.SortOrder;
    capturedAt?: Prisma.SortOrder;
};
export type StringFieldUpdateOperationsInput = {
    set?: string;
};
export type DateTimeFieldUpdateOperationsInput = {
    set?: Date | string;
};
export type SiteSubmissionSelect<ExtArgs extends runtime.Types.Extensions.InternalArgs = runtime.Types.Extensions.DefaultArgs> = runtime.Types.Extensions.GetSelect<{
    id?: boolean;
    siteId?: boolean;
    status?: boolean;
    payload?: boolean;
    capturedAt?: boolean;
}, ExtArgs["result"]["siteSubmission"]>;
export type SiteSubmissionSelectCreateManyAndReturn<ExtArgs extends runtime.Types.Extensions.InternalArgs = runtime.Types.Extensions.DefaultArgs> = runtime.Types.Extensions.GetSelect<{
    id?: boolean;
    siteId?: boolean;
    status?: boolean;
    payload?: boolean;
    capturedAt?: boolean;
}, ExtArgs["result"]["siteSubmission"]>;
export type SiteSubmissionSelectUpdateManyAndReturn<ExtArgs extends runtime.Types.Extensions.InternalArgs = runtime.Types.Extensions.DefaultArgs> = runtime.Types.Extensions.GetSelect<{
    id?: boolean;
    siteId?: boolean;
    status?: boolean;
    payload?: boolean;
    capturedAt?: boolean;
}, ExtArgs["result"]["siteSubmission"]>;
export type SiteSubmissionSelectScalar = {
    id?: boolean;
    siteId?: boolean;
    status?: boolean;
    payload?: boolean;
    capturedAt?: boolean;
};
export type SiteSubmissionOmit<ExtArgs extends runtime.Types.Extensions.InternalArgs = runtime.Types.Extensions.DefaultArgs> = runtime.Types.Extensions.GetOmit<"id" | "siteId" | "status" | "payload" | "capturedAt", ExtArgs["result"]["siteSubmission"]>;
export type $SiteSubmissionPayload<ExtArgs extends runtime.Types.Extensions.InternalArgs = runtime.Types.Extensions.DefaultArgs> = {
    name: "SiteSubmission";
    objects: {};
    scalars: runtime.Types.Extensions.GetPayloadResult<{
        id: string;
        siteId: string;
        /**
         * "submitted" | "error"
         */
        status: string;
        /**
         * Full plugin result payload for auditability. MAY be redacted by the plugin
         * (via SitePluginResult.auditPayload) to strip PII before persistence.
         */
        payload: runtime.JsonValue;
        capturedAt: Date;
    }, ExtArgs["result"]["siteSubmission"]>;
    composites: {};
};
export type SiteSubmissionGetPayload<S extends boolean | null | undefined | SiteSubmissionDefaultArgs> = runtime.Types.Result.GetResult<Prisma.$SiteSubmissionPayload, S>;
export type SiteSubmissionCountArgs<ExtArgs extends runtime.Types.Extensions.InternalArgs = runtime.Types.Extensions.DefaultArgs> = Omit<SiteSubmissionFindManyArgs, 'select' | 'include' | 'distinct' | 'omit'> & {
    select?: SiteSubmissionCountAggregateInputType | true;
};
export interface SiteSubmissionDelegate<ExtArgs extends runtime.Types.Extensions.InternalArgs = runtime.Types.Extensions.DefaultArgs, GlobalOmitOptions = {}> {
    [K: symbol]: {
        types: Prisma.TypeMap<ExtArgs>['model']['SiteSubmission'];
        meta: {
            name: 'SiteSubmission';
        };
    };
    /**
     * Find zero or one SiteSubmission that matches the filter.
     * @param {SiteSubmissionFindUniqueArgs} args - Arguments to find a SiteSubmission
     * @example
     * // Get one SiteSubmission
     * const siteSubmission = await prisma.siteSubmission.findUnique({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     */
    findUnique<T extends SiteSubmissionFindUniqueArgs>(args: Prisma.SelectSubset<T, SiteSubmissionFindUniqueArgs<ExtArgs>>): Prisma.Prisma__SiteSubmissionClient<runtime.Types.Result.GetResult<Prisma.$SiteSubmissionPayload<ExtArgs>, T, "findUnique", GlobalOmitOptions> | null, null, ExtArgs, GlobalOmitOptions>;
    /**
     * Find one SiteSubmission that matches the filter or throw an error with `error.code='P2025'`
     * if no matches were found.
     * @param {SiteSubmissionFindUniqueOrThrowArgs} args - Arguments to find a SiteSubmission
     * @example
     * // Get one SiteSubmission
     * const siteSubmission = await prisma.siteSubmission.findUniqueOrThrow({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     */
    findUniqueOrThrow<T extends SiteSubmissionFindUniqueOrThrowArgs>(args: Prisma.SelectSubset<T, SiteSubmissionFindUniqueOrThrowArgs<ExtArgs>>): Prisma.Prisma__SiteSubmissionClient<runtime.Types.Result.GetResult<Prisma.$SiteSubmissionPayload<ExtArgs>, T, "findUniqueOrThrow", GlobalOmitOptions>, never, ExtArgs, GlobalOmitOptions>;
    /**
     * Find the first SiteSubmission that matches the filter.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {SiteSubmissionFindFirstArgs} args - Arguments to find a SiteSubmission
     * @example
     * // Get one SiteSubmission
     * const siteSubmission = await prisma.siteSubmission.findFirst({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     */
    findFirst<T extends SiteSubmissionFindFirstArgs>(args?: Prisma.SelectSubset<T, SiteSubmissionFindFirstArgs<ExtArgs>>): Prisma.Prisma__SiteSubmissionClient<runtime.Types.Result.GetResult<Prisma.$SiteSubmissionPayload<ExtArgs>, T, "findFirst", GlobalOmitOptions> | null, null, ExtArgs, GlobalOmitOptions>;
    /**
     * Find the first SiteSubmission that matches the filter or
     * throw `PrismaKnownClientError` with `P2025` code if no matches were found.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {SiteSubmissionFindFirstOrThrowArgs} args - Arguments to find a SiteSubmission
     * @example
     * // Get one SiteSubmission
     * const siteSubmission = await prisma.siteSubmission.findFirstOrThrow({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     */
    findFirstOrThrow<T extends SiteSubmissionFindFirstOrThrowArgs>(args?: Prisma.SelectSubset<T, SiteSubmissionFindFirstOrThrowArgs<ExtArgs>>): Prisma.Prisma__SiteSubmissionClient<runtime.Types.Result.GetResult<Prisma.$SiteSubmissionPayload<ExtArgs>, T, "findFirstOrThrow", GlobalOmitOptions>, never, ExtArgs, GlobalOmitOptions>;
    /**
     * Find zero or more SiteSubmissions that matches the filter.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {SiteSubmissionFindManyArgs} args - Arguments to filter and select certain fields only.
     * @example
     * // Get all SiteSubmissions
     * const siteSubmissions = await prisma.siteSubmission.findMany()
     *
     * // Get first 10 SiteSubmissions
     * const siteSubmissions = await prisma.siteSubmission.findMany({ take: 10 })
     *
     * // Only select the `id`
     * const siteSubmissionWithIdOnly = await prisma.siteSubmission.findMany({ select: { id: true } })
     *
     */
    findMany<T extends SiteSubmissionFindManyArgs>(args?: Prisma.SelectSubset<T, SiteSubmissionFindManyArgs<ExtArgs>>): Prisma.PrismaPromise<runtime.Types.Result.GetResult<Prisma.$SiteSubmissionPayload<ExtArgs>, T, "findMany", GlobalOmitOptions>>;
    /**
     * Create a SiteSubmission.
     * @param {SiteSubmissionCreateArgs} args - Arguments to create a SiteSubmission.
     * @example
     * // Create one SiteSubmission
     * const SiteSubmission = await prisma.siteSubmission.create({
     *   data: {
     *     // ... data to create a SiteSubmission
     *   }
     * })
     *
     */
    create<T extends SiteSubmissionCreateArgs>(args: Prisma.SelectSubset<T, SiteSubmissionCreateArgs<ExtArgs>>): Prisma.Prisma__SiteSubmissionClient<runtime.Types.Result.GetResult<Prisma.$SiteSubmissionPayload<ExtArgs>, T, "create", GlobalOmitOptions>, never, ExtArgs, GlobalOmitOptions>;
    /**
     * Create many SiteSubmissions.
     * @param {SiteSubmissionCreateManyArgs} args - Arguments to create many SiteSubmissions.
     * @example
     * // Create many SiteSubmissions
     * const siteSubmission = await prisma.siteSubmission.createMany({
     *   data: [
     *     // ... provide data here
     *   ]
     * })
     *
     */
    createMany<T extends SiteSubmissionCreateManyArgs>(args?: Prisma.SelectSubset<T, SiteSubmissionCreateManyArgs<ExtArgs>>): Prisma.PrismaPromise<Prisma.BatchPayload>;
    /**
     * Create many SiteSubmissions and returns the data saved in the database.
     * @param {SiteSubmissionCreateManyAndReturnArgs} args - Arguments to create many SiteSubmissions.
     * @example
     * // Create many SiteSubmissions
     * const siteSubmission = await prisma.siteSubmission.createManyAndReturn({
     *   data: [
     *     // ... provide data here
     *   ]
     * })
     *
     * // Create many SiteSubmissions and only return the `id`
     * const siteSubmissionWithIdOnly = await prisma.siteSubmission.createManyAndReturn({
     *   select: { id: true },
     *   data: [
     *     // ... provide data here
     *   ]
     * })
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     *
     */
    createManyAndReturn<T extends SiteSubmissionCreateManyAndReturnArgs>(args?: Prisma.SelectSubset<T, SiteSubmissionCreateManyAndReturnArgs<ExtArgs>>): Prisma.PrismaPromise<runtime.Types.Result.GetResult<Prisma.$SiteSubmissionPayload<ExtArgs>, T, "createManyAndReturn", GlobalOmitOptions>>;
    /**
     * Delete a SiteSubmission.
     * @param {SiteSubmissionDeleteArgs} args - Arguments to delete one SiteSubmission.
     * @example
     * // Delete one SiteSubmission
     * const SiteSubmission = await prisma.siteSubmission.delete({
     *   where: {
     *     // ... filter to delete one SiteSubmission
     *   }
     * })
     *
     */
    delete<T extends SiteSubmissionDeleteArgs>(args: Prisma.SelectSubset<T, SiteSubmissionDeleteArgs<ExtArgs>>): Prisma.Prisma__SiteSubmissionClient<runtime.Types.Result.GetResult<Prisma.$SiteSubmissionPayload<ExtArgs>, T, "delete", GlobalOmitOptions>, never, ExtArgs, GlobalOmitOptions>;
    /**
     * Update one SiteSubmission.
     * @param {SiteSubmissionUpdateArgs} args - Arguments to update one SiteSubmission.
     * @example
     * // Update one SiteSubmission
     * const siteSubmission = await prisma.siteSubmission.update({
     *   where: {
     *     // ... provide filter here
     *   },
     *   data: {
     *     // ... provide data here
     *   }
     * })
     *
     */
    update<T extends SiteSubmissionUpdateArgs>(args: Prisma.SelectSubset<T, SiteSubmissionUpdateArgs<ExtArgs>>): Prisma.Prisma__SiteSubmissionClient<runtime.Types.Result.GetResult<Prisma.$SiteSubmissionPayload<ExtArgs>, T, "update", GlobalOmitOptions>, never, ExtArgs, GlobalOmitOptions>;
    /**
     * Delete zero or more SiteSubmissions.
     * @param {SiteSubmissionDeleteManyArgs} args - Arguments to filter SiteSubmissions to delete.
     * @example
     * // Delete a few SiteSubmissions
     * const { count } = await prisma.siteSubmission.deleteMany({
     *   where: {
     *     // ... provide filter here
     *   }
     * })
     *
     */
    deleteMany<T extends SiteSubmissionDeleteManyArgs>(args?: Prisma.SelectSubset<T, SiteSubmissionDeleteManyArgs<ExtArgs>>): Prisma.PrismaPromise<Prisma.BatchPayload>;
    /**
     * Update zero or more SiteSubmissions.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {SiteSubmissionUpdateManyArgs} args - Arguments to update one or more rows.
     * @example
     * // Update many SiteSubmissions
     * const siteSubmission = await prisma.siteSubmission.updateMany({
     *   where: {
     *     // ... provide filter here
     *   },
     *   data: {
     *     // ... provide data here
     *   }
     * })
     *
     */
    updateMany<T extends SiteSubmissionUpdateManyArgs>(args: Prisma.SelectSubset<T, SiteSubmissionUpdateManyArgs<ExtArgs>>): Prisma.PrismaPromise<Prisma.BatchPayload>;
    /**
     * Update zero or more SiteSubmissions and returns the data updated in the database.
     * @param {SiteSubmissionUpdateManyAndReturnArgs} args - Arguments to update many SiteSubmissions.
     * @example
     * // Update many SiteSubmissions
     * const siteSubmission = await prisma.siteSubmission.updateManyAndReturn({
     *   where: {
     *     // ... provide filter here
     *   },
     *   data: [
     *     // ... provide data here
     *   ]
     * })
     *
     * // Update zero or more SiteSubmissions and only return the `id`
     * const siteSubmissionWithIdOnly = await prisma.siteSubmission.updateManyAndReturn({
     *   select: { id: true },
     *   where: {
     *     // ... provide filter here
     *   },
     *   data: [
     *     // ... provide data here
     *   ]
     * })
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     *
     */
    updateManyAndReturn<T extends SiteSubmissionUpdateManyAndReturnArgs>(args: Prisma.SelectSubset<T, SiteSubmissionUpdateManyAndReturnArgs<ExtArgs>>): Prisma.PrismaPromise<runtime.Types.Result.GetResult<Prisma.$SiteSubmissionPayload<ExtArgs>, T, "updateManyAndReturn", GlobalOmitOptions>>;
    /**
     * Create or update one SiteSubmission.
     * @param {SiteSubmissionUpsertArgs} args - Arguments to update or create a SiteSubmission.
     * @example
     * // Update or create a SiteSubmission
     * const siteSubmission = await prisma.siteSubmission.upsert({
     *   create: {
     *     // ... data to create a SiteSubmission
     *   },
     *   update: {
     *     // ... in case it already exists, update
     *   },
     *   where: {
     *     // ... the filter for the SiteSubmission we want to update
     *   }
     * })
     */
    upsert<T extends SiteSubmissionUpsertArgs>(args: Prisma.SelectSubset<T, SiteSubmissionUpsertArgs<ExtArgs>>): Prisma.Prisma__SiteSubmissionClient<runtime.Types.Result.GetResult<Prisma.$SiteSubmissionPayload<ExtArgs>, T, "upsert", GlobalOmitOptions>, never, ExtArgs, GlobalOmitOptions>;
    /**
     * Count the number of SiteSubmissions.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {SiteSubmissionCountArgs} args - Arguments to filter SiteSubmissions to count.
     * @example
     * // Count the number of SiteSubmissions
     * const count = await prisma.siteSubmission.count({
     *   where: {
     *     // ... the filter for the SiteSubmissions we want to count
     *   }
     * })
    **/
    count<T extends SiteSubmissionCountArgs>(args?: Prisma.Subset<T, SiteSubmissionCountArgs>): Prisma.PrismaPromise<T extends runtime.Types.Utils.Record<'select', any> ? T['select'] extends true ? number : Prisma.GetScalarType<T['select'], SiteSubmissionCountAggregateOutputType> : number>;
    /**
     * Allows you to perform aggregations operations on a SiteSubmission.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {SiteSubmissionAggregateArgs} args - Select which aggregations you would like to apply and on what fields.
     * @example
     * // Ordered by age ascending
     * // Where email contains prisma.io
     * // Limited to the 10 users
     * const aggregations = await prisma.user.aggregate({
     *   _avg: {
     *     age: true,
     *   },
     *   where: {
     *     email: {
     *       contains: "prisma.io",
     *     },
     *   },
     *   orderBy: {
     *     age: "asc",
     *   },
     *   take: 10,
     * })
    **/
    aggregate<T extends SiteSubmissionAggregateArgs>(args: Prisma.Subset<T, SiteSubmissionAggregateArgs>): Prisma.PrismaPromise<GetSiteSubmissionAggregateType<T>>;
    /**
     * Group by SiteSubmission.
     * Note, that providing `undefined` is treated as the value not being there.
     * Read more here: https://pris.ly/d/null-undefined
     * @param {SiteSubmissionGroupByArgs} args - Group by arguments.
     * @example
     * // Group by city, order by createdAt, get count
     * const result = await prisma.user.groupBy({
     *   by: ['city', 'createdAt'],
     *   orderBy: {
     *     createdAt: true
     *   },
     *   _count: {
     *     _all: true
     *   },
     * })
     *
    **/
    groupBy<T extends SiteSubmissionGroupByArgs, HasSelectOrTake extends Prisma.Or<Prisma.Extends<'skip', Prisma.Keys<T>>, Prisma.Extends<'take', Prisma.Keys<T>>>, OrderByArg extends Prisma.True extends HasSelectOrTake ? {
        orderBy: SiteSubmissionGroupByArgs['orderBy'];
    } : {
        orderBy?: SiteSubmissionGroupByArgs['orderBy'];
    }, OrderFields extends Prisma.ExcludeUnderscoreKeys<Prisma.Keys<Prisma.MaybeTupleToUnion<T['orderBy']>>>, ByFields extends Prisma.MaybeTupleToUnion<T['by']>, ByValid extends Prisma.Has<ByFields, OrderFields>, HavingFields extends Prisma.GetHavingFields<T['having']>, HavingValid extends Prisma.Has<ByFields, HavingFields>, ByEmpty extends T['by'] extends never[] ? Prisma.True : Prisma.False, InputErrors extends ByEmpty extends Prisma.True ? `Error: "by" must not be empty.` : HavingValid extends Prisma.False ? {
        [P in HavingFields]: P extends ByFields ? never : P extends string ? `Error: Field "${P}" used in "having" needs to be provided in "by".` : [
            Error,
            'Field ',
            P,
            ` in "having" needs to be provided in "by"`
        ];
    }[HavingFields] : 'take' extends Prisma.Keys<T> ? 'orderBy' extends Prisma.Keys<T> ? ByValid extends Prisma.True ? {} : {
        [P in OrderFields]: P extends ByFields ? never : `Error: Field "${P}" in "orderBy" needs to be provided in "by"`;
    }[OrderFields] : 'Error: If you provide "take", you also need to provide "orderBy"' : 'skip' extends Prisma.Keys<T> ? 'orderBy' extends Prisma.Keys<T> ? ByValid extends Prisma.True ? {} : {
        [P in OrderFields]: P extends ByFields ? never : `Error: Field "${P}" in "orderBy" needs to be provided in "by"`;
    }[OrderFields] : 'Error: If you provide "skip", you also need to provide "orderBy"' : ByValid extends Prisma.True ? {} : {
        [P in OrderFields]: P extends ByFields ? never : `Error: Field "${P}" in "orderBy" needs to be provided in "by"`;
    }[OrderFields]>(args: Prisma.SubsetIntersection<T, SiteSubmissionGroupByArgs, OrderByArg> & InputErrors): {} extends InputErrors ? GetSiteSubmissionGroupByPayload<T> : Prisma.PrismaPromise<InputErrors>;
    /**
     * Fields of the SiteSubmission model
     */
    readonly fields: SiteSubmissionFieldRefs;
}
/**
 * The delegate class that acts as a "Promise-like" for SiteSubmission.
 * Why is this prefixed with `Prisma__`?
 * Because we want to prevent naming conflicts as mentioned in
 * https://github.com/prisma/prisma-client-js/issues/707
 */
export interface Prisma__SiteSubmissionClient<T, Null = never, ExtArgs extends runtime.Types.Extensions.InternalArgs = runtime.Types.Extensions.DefaultArgs, GlobalOmitOptions = {}> extends Prisma.PrismaPromise<T> {
    readonly [Symbol.toStringTag]: "PrismaPromise";
    /**
     * Attaches callbacks for the resolution and/or rejection of the Promise.
     * @param onfulfilled The callback to execute when the Promise is resolved.
     * @param onrejected The callback to execute when the Promise is rejected.
     * @returns A Promise for the completion of which ever callback is executed.
     */
    then<TResult1 = T, TResult2 = never>(onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | undefined | null, onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | undefined | null): runtime.Types.Utils.JsPromise<TResult1 | TResult2>;
    /**
     * Attaches a callback for only the rejection of the Promise.
     * @param onrejected The callback to execute when the Promise is rejected.
     * @returns A Promise for the completion of the callback.
     */
    catch<TResult = never>(onrejected?: ((reason: any) => TResult | PromiseLike<TResult>) | undefined | null): runtime.Types.Utils.JsPromise<T | TResult>;
    /**
     * Attaches a callback that is invoked when the Promise is settled (fulfilled or rejected). The
     * resolved value cannot be modified from the callback.
     * @param onfinally The callback to execute when the Promise is settled (fulfilled or rejected).
     * @returns A Promise for the completion of the callback.
     */
    finally(onfinally?: (() => void) | undefined | null): runtime.Types.Utils.JsPromise<T>;
}
/**
 * Fields of the SiteSubmission model
 */
export interface SiteSubmissionFieldRefs {
    readonly id: Prisma.FieldRef<"SiteSubmission", 'String'>;
    readonly siteId: Prisma.FieldRef<"SiteSubmission", 'String'>;
    readonly status: Prisma.FieldRef<"SiteSubmission", 'String'>;
    readonly payload: Prisma.FieldRef<"SiteSubmission", 'Json'>;
    readonly capturedAt: Prisma.FieldRef<"SiteSubmission", 'DateTime'>;
}
/**
 * SiteSubmission findUnique
 */
export type SiteSubmissionFindUniqueArgs<ExtArgs extends runtime.Types.Extensions.InternalArgs = runtime.Types.Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the SiteSubmission
     */
    select?: Prisma.SiteSubmissionSelect<ExtArgs> | null;
    /**
     * Omit specific fields from the SiteSubmission
     */
    omit?: Prisma.SiteSubmissionOmit<ExtArgs> | null;
    /**
     * Filter, which SiteSubmission to fetch.
     */
    where: Prisma.SiteSubmissionWhereUniqueInput;
};
/**
 * SiteSubmission findUniqueOrThrow
 */
export type SiteSubmissionFindUniqueOrThrowArgs<ExtArgs extends runtime.Types.Extensions.InternalArgs = runtime.Types.Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the SiteSubmission
     */
    select?: Prisma.SiteSubmissionSelect<ExtArgs> | null;
    /**
     * Omit specific fields from the SiteSubmission
     */
    omit?: Prisma.SiteSubmissionOmit<ExtArgs> | null;
    /**
     * Filter, which SiteSubmission to fetch.
     */
    where: Prisma.SiteSubmissionWhereUniqueInput;
};
/**
 * SiteSubmission findFirst
 */
export type SiteSubmissionFindFirstArgs<ExtArgs extends runtime.Types.Extensions.InternalArgs = runtime.Types.Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the SiteSubmission
     */
    select?: Prisma.SiteSubmissionSelect<ExtArgs> | null;
    /**
     * Omit specific fields from the SiteSubmission
     */
    omit?: Prisma.SiteSubmissionOmit<ExtArgs> | null;
    /**
     * Filter, which SiteSubmission to fetch.
     */
    where?: Prisma.SiteSubmissionWhereInput;
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/sorting Sorting Docs}
     *
     * Determine the order of SiteSubmissions to fetch.
     */
    orderBy?: Prisma.SiteSubmissionOrderByWithRelationInput | Prisma.SiteSubmissionOrderByWithRelationInput[];
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination#cursor-based-pagination Cursor Docs}
     *
     * Sets the position for searching for SiteSubmissions.
     */
    cursor?: Prisma.SiteSubmissionWhereUniqueInput;
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     *
     * Take `±n` SiteSubmissions from the position of the cursor.
     */
    take?: number;
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     *
     * Skip the first `n` SiteSubmissions.
     */
    skip?: number;
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/distinct Distinct Docs}
     *
     * Filter by unique combinations of SiteSubmissions.
     */
    distinct?: Prisma.SiteSubmissionScalarFieldEnum | Prisma.SiteSubmissionScalarFieldEnum[];
};
/**
 * SiteSubmission findFirstOrThrow
 */
export type SiteSubmissionFindFirstOrThrowArgs<ExtArgs extends runtime.Types.Extensions.InternalArgs = runtime.Types.Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the SiteSubmission
     */
    select?: Prisma.SiteSubmissionSelect<ExtArgs> | null;
    /**
     * Omit specific fields from the SiteSubmission
     */
    omit?: Prisma.SiteSubmissionOmit<ExtArgs> | null;
    /**
     * Filter, which SiteSubmission to fetch.
     */
    where?: Prisma.SiteSubmissionWhereInput;
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/sorting Sorting Docs}
     *
     * Determine the order of SiteSubmissions to fetch.
     */
    orderBy?: Prisma.SiteSubmissionOrderByWithRelationInput | Prisma.SiteSubmissionOrderByWithRelationInput[];
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination#cursor-based-pagination Cursor Docs}
     *
     * Sets the position for searching for SiteSubmissions.
     */
    cursor?: Prisma.SiteSubmissionWhereUniqueInput;
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     *
     * Take `±n` SiteSubmissions from the position of the cursor.
     */
    take?: number;
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     *
     * Skip the first `n` SiteSubmissions.
     */
    skip?: number;
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/distinct Distinct Docs}
     *
     * Filter by unique combinations of SiteSubmissions.
     */
    distinct?: Prisma.SiteSubmissionScalarFieldEnum | Prisma.SiteSubmissionScalarFieldEnum[];
};
/**
 * SiteSubmission findMany
 */
export type SiteSubmissionFindManyArgs<ExtArgs extends runtime.Types.Extensions.InternalArgs = runtime.Types.Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the SiteSubmission
     */
    select?: Prisma.SiteSubmissionSelect<ExtArgs> | null;
    /**
     * Omit specific fields from the SiteSubmission
     */
    omit?: Prisma.SiteSubmissionOmit<ExtArgs> | null;
    /**
     * Filter, which SiteSubmissions to fetch.
     */
    where?: Prisma.SiteSubmissionWhereInput;
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/sorting Sorting Docs}
     *
     * Determine the order of SiteSubmissions to fetch.
     */
    orderBy?: Prisma.SiteSubmissionOrderByWithRelationInput | Prisma.SiteSubmissionOrderByWithRelationInput[];
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination#cursor-based-pagination Cursor Docs}
     *
     * Sets the position for listing SiteSubmissions.
     */
    cursor?: Prisma.SiteSubmissionWhereUniqueInput;
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     *
     * Take `±n` SiteSubmissions from the position of the cursor.
     */
    take?: number;
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/pagination Pagination Docs}
     *
     * Skip the first `n` SiteSubmissions.
     */
    skip?: number;
    /**
     * {@link https://www.prisma.io/docs/concepts/components/prisma-client/distinct Distinct Docs}
     *
     * Filter by unique combinations of SiteSubmissions.
     */
    distinct?: Prisma.SiteSubmissionScalarFieldEnum | Prisma.SiteSubmissionScalarFieldEnum[];
};
/**
 * SiteSubmission create
 */
export type SiteSubmissionCreateArgs<ExtArgs extends runtime.Types.Extensions.InternalArgs = runtime.Types.Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the SiteSubmission
     */
    select?: Prisma.SiteSubmissionSelect<ExtArgs> | null;
    /**
     * Omit specific fields from the SiteSubmission
     */
    omit?: Prisma.SiteSubmissionOmit<ExtArgs> | null;
    /**
     * The data needed to create a SiteSubmission.
     */
    data: Prisma.XOR<Prisma.SiteSubmissionCreateInput, Prisma.SiteSubmissionUncheckedCreateInput>;
};
/**
 * SiteSubmission createMany
 */
export type SiteSubmissionCreateManyArgs<ExtArgs extends runtime.Types.Extensions.InternalArgs = runtime.Types.Extensions.DefaultArgs> = {
    /**
     * The data used to create many SiteSubmissions.
     */
    data: Prisma.SiteSubmissionCreateManyInput | Prisma.SiteSubmissionCreateManyInput[];
    skipDuplicates?: boolean;
};
/**
 * SiteSubmission createManyAndReturn
 */
export type SiteSubmissionCreateManyAndReturnArgs<ExtArgs extends runtime.Types.Extensions.InternalArgs = runtime.Types.Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the SiteSubmission
     */
    select?: Prisma.SiteSubmissionSelectCreateManyAndReturn<ExtArgs> | null;
    /**
     * Omit specific fields from the SiteSubmission
     */
    omit?: Prisma.SiteSubmissionOmit<ExtArgs> | null;
    /**
     * The data used to create many SiteSubmissions.
     */
    data: Prisma.SiteSubmissionCreateManyInput | Prisma.SiteSubmissionCreateManyInput[];
    skipDuplicates?: boolean;
};
/**
 * SiteSubmission update
 */
export type SiteSubmissionUpdateArgs<ExtArgs extends runtime.Types.Extensions.InternalArgs = runtime.Types.Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the SiteSubmission
     */
    select?: Prisma.SiteSubmissionSelect<ExtArgs> | null;
    /**
     * Omit specific fields from the SiteSubmission
     */
    omit?: Prisma.SiteSubmissionOmit<ExtArgs> | null;
    /**
     * The data needed to update a SiteSubmission.
     */
    data: Prisma.XOR<Prisma.SiteSubmissionUpdateInput, Prisma.SiteSubmissionUncheckedUpdateInput>;
    /**
     * Choose, which SiteSubmission to update.
     */
    where: Prisma.SiteSubmissionWhereUniqueInput;
};
/**
 * SiteSubmission updateMany
 */
export type SiteSubmissionUpdateManyArgs<ExtArgs extends runtime.Types.Extensions.InternalArgs = runtime.Types.Extensions.DefaultArgs> = {
    /**
     * The data used to update SiteSubmissions.
     */
    data: Prisma.XOR<Prisma.SiteSubmissionUpdateManyMutationInput, Prisma.SiteSubmissionUncheckedUpdateManyInput>;
    /**
     * Filter which SiteSubmissions to update
     */
    where?: Prisma.SiteSubmissionWhereInput;
    /**
     * Limit how many SiteSubmissions to update.
     */
    limit?: number;
};
/**
 * SiteSubmission updateManyAndReturn
 */
export type SiteSubmissionUpdateManyAndReturnArgs<ExtArgs extends runtime.Types.Extensions.InternalArgs = runtime.Types.Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the SiteSubmission
     */
    select?: Prisma.SiteSubmissionSelectUpdateManyAndReturn<ExtArgs> | null;
    /**
     * Omit specific fields from the SiteSubmission
     */
    omit?: Prisma.SiteSubmissionOmit<ExtArgs> | null;
    /**
     * The data used to update SiteSubmissions.
     */
    data: Prisma.XOR<Prisma.SiteSubmissionUpdateManyMutationInput, Prisma.SiteSubmissionUncheckedUpdateManyInput>;
    /**
     * Filter which SiteSubmissions to update
     */
    where?: Prisma.SiteSubmissionWhereInput;
    /**
     * Limit how many SiteSubmissions to update.
     */
    limit?: number;
};
/**
 * SiteSubmission upsert
 */
export type SiteSubmissionUpsertArgs<ExtArgs extends runtime.Types.Extensions.InternalArgs = runtime.Types.Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the SiteSubmission
     */
    select?: Prisma.SiteSubmissionSelect<ExtArgs> | null;
    /**
     * Omit specific fields from the SiteSubmission
     */
    omit?: Prisma.SiteSubmissionOmit<ExtArgs> | null;
    /**
     * The filter to search for the SiteSubmission to update in case it exists.
     */
    where: Prisma.SiteSubmissionWhereUniqueInput;
    /**
     * In case the SiteSubmission found by the `where` argument doesn't exist, create a new SiteSubmission with this data.
     */
    create: Prisma.XOR<Prisma.SiteSubmissionCreateInput, Prisma.SiteSubmissionUncheckedCreateInput>;
    /**
     * In case the SiteSubmission was found with the provided `where` argument, update it with this data.
     */
    update: Prisma.XOR<Prisma.SiteSubmissionUpdateInput, Prisma.SiteSubmissionUncheckedUpdateInput>;
};
/**
 * SiteSubmission delete
 */
export type SiteSubmissionDeleteArgs<ExtArgs extends runtime.Types.Extensions.InternalArgs = runtime.Types.Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the SiteSubmission
     */
    select?: Prisma.SiteSubmissionSelect<ExtArgs> | null;
    /**
     * Omit specific fields from the SiteSubmission
     */
    omit?: Prisma.SiteSubmissionOmit<ExtArgs> | null;
    /**
     * Filter which SiteSubmission to delete.
     */
    where: Prisma.SiteSubmissionWhereUniqueInput;
};
/**
 * SiteSubmission deleteMany
 */
export type SiteSubmissionDeleteManyArgs<ExtArgs extends runtime.Types.Extensions.InternalArgs = runtime.Types.Extensions.DefaultArgs> = {
    /**
     * Filter which SiteSubmissions to delete
     */
    where?: Prisma.SiteSubmissionWhereInput;
    /**
     * Limit how many SiteSubmissions to delete.
     */
    limit?: number;
};
/**
 * SiteSubmission without action
 */
export type SiteSubmissionDefaultArgs<ExtArgs extends runtime.Types.Extensions.InternalArgs = runtime.Types.Extensions.DefaultArgs> = {
    /**
     * Select specific fields to fetch from the SiteSubmission
     */
    select?: Prisma.SiteSubmissionSelect<ExtArgs> | null;
    /**
     * Omit specific fields from the SiteSubmission
     */
    omit?: Prisma.SiteSubmissionOmit<ExtArgs> | null;
};
